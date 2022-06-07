const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");
const webpack = require("webpack");
const cors = require("cors");
const HTMLWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const BundleAnalyzerPlugin = require("webpack-bundle-analyzer").BundleAnalyzerPlugin;
const TOML = require("@iarna/toml");
const fetch = require("node-fetch");
const packageLock = require("./package-lock.json");
const request = require("request");
const internalIp = require("internal-ip");

function createHTTPSConfig() {
  const certBase = '/home/lonycell/server/.certs';

  if (fs.existsSync(path.join(certBase, "pet-mom.club"))) {
    const key = fs.readFileSync(path.join(certBase, "pet-mom.club", "key.pem"));
    const cert = fs.readFileSync(path.join(certBase, "pet-mom.club", "cert.pem"));

    return { key, cert };
  } else {
    const pems = selfsigned.generate(
      [
        {
          name: "commonName",
          value: "localhost"
        }
      ],
      {
        days: 365,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          {
            name: "subjectAltName",
            altNames: [
              {
                type: 2,
                value: "localhost"
              },
              {
                type: 2,
                value: "hubs.local"
              }
            ]
          }
        ]
      }
    );

    if (!fs.existsSync(path.join(__dirname, "certs"))) {
      fs.mkdirSync(path.join(__dirname, "certs"));
      fs.writeFileSync(path.join(__dirname, "certs", "cert.pem"), pems.cert);
      fs.writeFileSync(path.join(__dirname, "certs", "key.pem"), pems.private);
    }

    return {
      key: pems.private,
      cert: pems.cert
    };
  }
}

function getModuleDependencies(moduleName) {
  const deps = packageLock.dependencies;
  const arr = [];

  const gatherDeps = name => {
    arr.push(path.join(__dirname, "node_modules", name) + path.sep);

    const moduleDef = deps[name];

    if (moduleDef && moduleDef.requires) {
      for (const requiredModuleName in moduleDef.requires) {
        gatherDeps(requiredModuleName);
      }
    }
  };

  gatherDeps(moduleName);

  return arr;
}

function deepModuleDependencyTest(modulesArr) {
  const deps = [];

  for (const moduleName of modulesArr) {
    const moduleDependencies = getModuleDependencies(moduleName);
    deps.push(...moduleDependencies);
  }

  return module => {
    if (!module.nameForCondition) {
      return false;
    }

    const name = module.nameForCondition();

    return deps.some(depName => name.startsWith(depName));
  };
}

function createDefaultAppConfig() {
  const schemaPath = path.join(__dirname, "src", "schema.toml");
  const schemaString = fs.readFileSync(schemaPath).toString();

  let appConfigSchema;

  try {
    appConfigSchema = TOML.parse(schemaString);
  } catch (e) {
    console.error("Error parsing schema.toml on line " + e.line + ", column " + e.column + ": " + e.message);
    throw e;
  }

  const appConfig = {};

  for (const [categoryName, category] of Object.entries(appConfigSchema)) {
    appConfig[categoryName] = {};

    // Enable all features with a boolean type
    if (categoryName === "features") {
      for (const [key, schema] of Object.entries(category)) {
        if (key === "require_account_for_join" || key === "disable_room_creation") {
          appConfig[categoryName][key] = false;
        } else {
          appConfig[categoryName][key] = schema.type === "boolean" ? true : null;
        }
      }
    }
  }

  const themesPath = path.join(__dirname, "themes.json");

  if (fs.existsSync(themesPath)) {
    const themesString = fs.readFileSync(themesPath).toString();
    const themes = JSON.parse(themesString);
    appConfig.theme.themes = themes;
  }

  return appConfig;
}

async function fetchAppConfigAndEnvironmentVars() {
  if (!fs.existsSync(".ret.credentials")) {
    throw new Error("Not logged in to Hubs Cloud. Run `npm run login` first.");
  }

  const { host, token } = JSON.parse(fs.readFileSync(".ret.credentials"));

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  // Load the Hubs Cloud instance's app config in development
  const appConfigsResponse = await fetch(`https://${host}/api/v1/app_configs`, { headers });

  if (!appConfigsResponse.ok) {
    throw new Error(`Error fetching Hubs Cloud config "${appConfigsResponse.statusText}"`);
  }

  const appConfig = await appConfigsResponse.json();

  // www.pet-mom.club doesn't run ita
  if (host === "www.pet-mom.club") {
    return appConfig;
  }

  const hubsConfigsResponse = await fetch(`https://${host}/api/ita/configs/hubs`, { headers });

  const hubsConfigs = await hubsConfigsResponse.json();

  if (!hubsConfigsResponse.ok) {
    throw new Error(`Error fetching Hubs Cloud config "${hubsConfigsResponse.statusText}"`);
  }

  const { shortlink_domain, thumbnail_server } = hubsConfigs.general;

  const localIp = process.env.HOST_IP || (await internalIp.v4()) || "localhost";

  process.env.RETICULUM_SERVER = host;
  process.env.SHORTLINK_DOMAIN = shortlink_domain;
  process.env.CORS_PROXY_SERVER = `${localIp}:8080/cors-proxy`;
  process.env.THUMBNAIL_SERVER = thumbnail_server;
  process.env.NON_CORS_PROXY_DOMAINS = `${localIp},hubs.local,localhost,www.pet-mom.club`;

  return appConfig;
}

function htmlPagePlugin({ filename, extraChunks = [], chunksSortMode, inject }) {
  const chunkName = filename.match(/(.+).html/)[1];
  const options = {
    filename,
    template: path.join(__dirname, "src", filename),
    chunks: [...extraChunks, chunkName],
    minify: {
      removeComments: false
    }
  };

  if (chunksSortMode) options.chunksSortMode = chunksSortMode;
  if (inject) options.inject = inject;

  return new HTMLWebpackPlugin(options);
}

module.exports = async (env, argv) => {
  env = env || {};

  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  let appConfig = undefined;

  const mainHost = "www.pet-mom.club";

  // Object.assign(process.env, {
  //   HOST: mainHost,
  //   RETICULUM_SOCKET_SERVER: mainHost,
  //   CORS_PROXY_SERVER: "hubs-proxy.local:4000",
  //   NON_CORS_PROXY_DOMAINS: `${mainHost},www.pet-mom.club`,
  //   BASE_ASSETS_PATH: `https://${mainHost}:8080/`,
  //   RETICULUM_SERVER: `${mainHost}:4000`,
  //   POSTGREST_SERVER: "",
  //   ITA_SERVER: "",
  //   UPLOADS_HOST: `https://${mainHost}:4000`
  // });
  Object.assign(process.env, {
    HOST: mainHost,
    RETICULUM_SOCKET_SERVER: mainHost,
    //FIXME: CORS_PROXY_SERVER: `${mainHost}:8080`,
    CORS_PROXY_SERVER: `${mainHost}:4000`,
    //FIXME NON_CORS_PROXY_DOMAINS: `${mainHost}, https://raw.githubusercontent.com, https://hubs-proxy.com`,
    NON_CORS_PROXY_DOMAINS: mainHost,
    BASE_ASSETS_PATH: `/hubs-origin/`,
    RETICULUM_SERVER: mainHost,
    POSTGREST_SERVER: ``,
    ITA_SERVER: "",
    UPLOADS_HOST: mainHost
  });

  const host = process.env.HOST_IP || "www.pet-mom.club";

  const liveReload = !!process.env.LIVE_RELOAD || false;

  const legacyBabelConfig = {
    presets: ["@babel/react", ["@babel/env", { targets: { ie: 11 } }]],
    plugins: [
      "@babel/proposal-class-properties",
      "@babel/proposal-object-rest-spread",
      "@babel/plugin-transform-async-to-generator",
      "@babel/plugin-proposal-optional-chaining",
      "@babel/plugin-proposal-private-property-in-object",
      "@babel/plugin-proposal-private-methods"
    ]
  };

  const devServerHeaders = {
    "Access-Control-Allow-Origin": "*"
  };

  if (process.env.DEV_CSP_SOURCE) {
    const CSPResp = await fetch(`https://${process.env.DEV_CSP_SOURCE}/`);
    const remoteCSP = CSPResp.headers.get("content-security-policy");
    devServerHeaders["content-security-policy"] = remoteCSP;
  }

  return {
    node: {
      Buffer: false,
      fs: "empty"
    },
    entry: {
      support: path.join(__dirname, "src", "support.js"),
      index: path.join(__dirname, "src", "index.js"),
      hub: path.join(__dirname, "src", "hub.js"),
      scene: path.join(__dirname, "src", "scene.js"),
      avatar: path.join(__dirname, "src", "avatar.js"),
      link: path.join(__dirname, "src", "link.js"),
      discord: path.join(__dirname, "src", "discord.js"),
      cloud: path.join(__dirname, "src", "cloud.js"),
      signin: path.join(__dirname, "src", "signin.js"),
      verify: path.join(__dirname, "src", "verify.js"),
      tokens: path.join(__dirname, "src", "tokens.js"),
      "whats-new": path.join(__dirname, "src", "whats-new.js"),
      "webxr-polyfill": path.join(__dirname, "src", "webxr-polyfill.js")
    },
    output: {
      filename: "assets/js/[name]-[chunkhash].js",
      publicPath: process.env.BASE_ASSETS_PATH || ""
    },
    devtool: argv.mode === "production" ? "source-map" : "inline-source-map",
    devServer: {
      https: createHTTPSConfig(),
      host: "0.0.0.0",
      public: `${host}:8080`,
      useLocalIp: true,
      allowedHosts: [host, "*"],
      headers: devServerHeaders,
      hot: liveReload,
      inline: liveReload,
      historyApiFallback: {
        rewrites: [
          { from: /^\/signin/, to: "/signin.html" },
          { from: /^\/discord/, to: "/discord.html" },
          { from: /^\/cloud/, to: "/cloud.html" },
          { from: /^\/verify/, to: "/verify.html" },
          { from: /^\/tokens/, to: "/tokens.html" },
          { from: /^\/whats-new/, to: "/whats-new.html" }
        ]
      },
      before: function(app) {
        app.all("/cors-proxy/*", (req, res) => {
          res.header("Access-Control-Allow-Origin", "*");
          res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.header("Access-Control-Allow-Headers", "Range");
          res.header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Encoding, Content-Length, Content-Range, Hub-Name, Hub-Entity-Type"
          );
          res.header("Vary", "Origin");
          res.header("X-Content-Type-Options", "nosniff");

          const redirectLocation = req.header("location");

          if (redirectLocation) {
            res.header("Location", "https://www.pet-mom.club:8080/cors-proxy/" + redirectLocation);
          }

          if (req.method === "OPTIONS") {
            res.send();
          } else {
            const url = req.originalUrl.replace("/cors-proxy/", "");
            request({ url, method: req.method }, error => {
              if (error) {
                console.error(`cors-proxy: error fetching "${url}"\n`, error);
                return;
              }
            }).pipe(res);
          }
        });

        app.use(cors({ origin: /www\.pet-mom\.club(:\d*)?$/ }));
        app.head("*", function(req, res, next) {
          if (req.method === "HEAD") {
            res.append("Date", new Date().toGMTString());
            res.send("");
          } else {
            next();
          }
        });
      }
    },
    performance: {
      // Ignore media and sourcemaps when warning about file size.
      assetFilter(assetFilename) {
        return !/\.(map|png|jpg|gif|glb|webm)$/.test(assetFilename);
      }
    },
    module: {
      rules: [
        {
          test: /\.html$/,
          loader: "html-loader",
          options: {
            // <a-asset-item>'s src property is overwritten with the correct transformed asset url.
            attrs: ["img:src", "a-asset-item:src", "audio:src", "source:src"]
          }
        },
        {
          test: /\.worker\.js$/,
          loader: "worker-loader",
          options: {
            name: "assets/js/[name]-[hash].js",
            publicPath: "/",
            inline: true
          }
        },
        {
          test: [
            path.resolve(__dirname, "src", "utils", "configs.js"),
            path.resolve(__dirname, "src", "utils", "i18n.js"),
            path.resolve(__dirname, "src", "support.js")
          ],
          loader: "babel-loader",
          options: legacyBabelConfig
        },
        {
          test: [
            path.resolve(__dirname, "node_modules", "three", "examples", "js", "libs", "basis", "basis_transcoder.js"),
            path.resolve(
              __dirname,
              "node_modules",
              "three",
              "examples",
              "js",
              "libs",
              "draco",
              "gltf",
              "draco_decoder.js"
            ),
            path.resolve(
              __dirname,
              "node_modules",
              "three",
              "examples",
              "js",
              "libs",
              "draco",
              "gltf",
              "draco_wasm_wrapper.js"
            )
          ],
          loader: "file-loader",
          options: {
            outputPath: "assets/raw-js",
            name: "[name]-[hash].[ext]"
          }
        },
        {
          test: /\.js$/,
          include: [path.resolve(__dirname, "src")],
          exclude: [path.resolve(__dirname, "node_modules")],
          loader: "babel-loader"
        },
        {
          test: /\.(scss|css)$/,
          use: [
            {
              loader: MiniCssExtractPlugin.loader
            },
            {
              loader: "css-loader",
              options: {
                name: "[path][name]-[hash].[ext]",
                localIdentName: "[name]__[local]__[hash:base64:5]",
                camelCase: true
              }
            },
            "sass-loader"
          ]
        },
        {
          test: /\.svg$/,
          include: [path.resolve(__dirname, "src", "react-components")],
          use: [
            {
              loader: "@svgr/webpack",
              options: {
                titleProp: true,
                replaceAttrValues: { "#000": "{props.color}" },
                template: require("./src/react-components/icons/IconTemplate"),
                svgoConfig: {
                  plugins: {
                    removeViewBox: false,
                    mergePaths: false,
                    convertShapeToPath: false,
                    removeHiddenElems: false
                  }
                }
              }
            },
            "url-loader"
          ]
        },
        {
          test: /\.(png|jpg|gif|glb|ogg|mp3|mp4|wav|woff2|svg|webm|3dl|cube)$/,
          use: {
            loader: "file-loader",
            options: {
              name: "[path][name]-[hash].[ext]",
              context: path.join(__dirname, "src")
            }
          }
        },
        {
          test: /\.(wasm)$/,
          type: "javascript/auto",
          use: {
            loader: "file-loader",
            options: {
              outputPath: "assets/wasm",
              name: "[name]-[hash].[ext]"
            }
          }
        },
        {
          test: /\.(glsl|frag|vert)$/,
          use: { loader: "raw-loader" }
        },
        {
          test: /\.webmanifest$/i,
          use: [
            {
              loader: 'file-loader',
              options: {
                name: '[name].[ext]'
              }
            },
            {
              loader: 'webmanifest-loader',
              options: {
                name: '메타허브',
                shortName: '메타허브',
                description: '메타허브'
              }
            }
          ]
        },
      ]
    },

    optimization: {
      splitChunks: {
        maxAsyncRequests: 10,
        maxInitialRequests: 10,
        cacheGroups: {
          frontend: {
            test: deepModuleDependencyTest([
              "react",
              "react-dom",
              "prop-types",
              "raven-js",
              "react-intl",
              "classnames",
              "react-router",
              "@fortawesome/fontawesome-svg-core",
              "@fortawesome/free-solid-svg-icons",
              "@fortawesome/react-fontawesome"
            ]),
            name: "frontend",
            chunks: "initial",
            priority: 40
          },
          engine: {
            test: deepModuleDependencyTest(["aframe", "three"]),
            name: "engine",
            chunks: "initial",
            priority: 30
          },
          store: {
            test: deepModuleDependencyTest(["phoenix", "jsonschema", "event-target-shim", "jwt-decode", "js-cookie"]),
            name: "store",
            chunks: "initial",
            priority: 20
          },
          hubVendors: {
            test: /[\\/]node_modules[\\/]/,
            name: "hub-vendors",
            chunks: chunk => chunk.name === "hub",
            priority: 10
          }
        }
      }
    },
    plugins: [
      new BundleAnalyzerPlugin({
        analyzerMode: env && env.bundleAnalyzer ? "server" : "disabled"
      }),
      htmlPagePlugin({
        filename: "index.html",
        extraChunks: ["support"],
        chunksSortMode: "manual"
      }),
      htmlPagePlugin({
        filename: "hub.html",
        extraChunks: ["webxr-polyfill", "support"],
        chunksSortMode: "manual",
        inject: "head"
      }),
      htmlPagePlugin({
        filename: "scene.html",
        extraChunks: ["support"],
        chunksSortMode: "manual",
        inject: "head"
      }),
      htmlPagePlugin({
        filename: "avatar.html",
        extraChunks: ["support"],
        chunksSortMode: "manual",
        inject: "head"
      }),
      htmlPagePlugin({
        filename: "link.html",
        extraChunks: ["support"],
        chunksSortMode: "manual"
      }),
      htmlPagePlugin({
        filename: "discord.html"
      }),
      htmlPagePlugin({
        filename: "whats-new.html",
        inject: "head"
      }),
      htmlPagePlugin({
        filename: "cloud.html",
        inject: "head"
      }),
      htmlPagePlugin({
        filename: "signin.html"
      }),
      htmlPagePlugin({
        filename: "verify.html"
      }),
      htmlPagePlugin({
        filename: "tokens.html"
      }),
      new CopyWebpackPlugin([
        {
          from: "src/hub.service.js",
          to: "hub.service.js"
        }
      ]),
      new CopyWebpackPlugin([
        {
          from: "src/schema.toml",
          to: "schema.toml"
        }
      ]),
      // new CopyWebpackPlugin([
      //   {
      //     from: "src/manifest.webmanifest",
      //     to: "manifest.webmanifest"
      //   }
      // ]),
      new MiniCssExtractPlugin({
        filename: "assets/stylesheets/[name]-[contenthash].css",
        disable: false
      }),
      new webpack.DefinePlugin({
        "process.env": JSON.stringify({
          NODE_ENV: "production",
          SHORTLINK_DOMAIN: process.env.SHORTLINK_DOMAIN,
          RETICULUM_SERVER: process.env.RETICULUM_SERVER,
          RETICULUM_SOCKET_SERVER: process.env.RETICULUM_SOCKET_SERVER,
          THUMBNAIL_SERVER: process.env.THUMBNAIL_SERVER,
          CORS_PROXY_SERVER: process.env.CORS_PROXY_SERVER,
          NON_CORS_PROXY_DOMAINS: process.env.NON_CORS_PROXY_DOMAINS,
          BUILD_VERSION: process.env.BUILD_VERSION,
          SENTRY_DSN: process.env.SENTRY_DSN,
          GA_TRACKING_ID: process.env.GA_TRACKING_ID,
          POSTGREST_SERVER: process.env.POSTGREST_SERVER,
          UPLOADS_HOST: process.env.UPLOADS_HOST,
          BASE_ASSETS_PATH: process.env.BASE_ASSETS_PATH,
          APP_CONFIG: appConfig
        })
      })
    ]
  };
};
