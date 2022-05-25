import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import selfsigned from 'selfsigned';
import webpack from 'webpack';
import cors from 'cors';
import HTMLWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import TOML from '@iarna/toml';
import fetch from 'node-fetch';
import request from 'request';
import {internalIpV4} from 'internal-ip';
import IconTemplate from './src/react-components/icons/IconTemplate.js';

import { createRequire } from 'module';
// import FaviconsWebpackPlugin from 'favicons-webpack-plugin';

const require = createRequire(import.meta.url);
const packageLock = JSON.parse(fs.readFileSync('./package-lock.json'));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {defaultTemplate} = IconTemplate;

//======================================================================
function createHTTPSConfig() {
  if (fs.existsSync(path.join(__dirname, "certs"))) {
    const key = fs.readFileSync(path.join(__dirname, "certs", "key.pem"));
    const cert = fs.readFileSync(path.join(__dirname, "certs", "cert.pem"));

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
                value: "localhost"
              }
            ]
          }
        ]
      }
    );

    fs.mkdirSync(path.join(__dirname, "certs"));
    fs.writeFileSync(path.join(__dirname, "certs", "cert.pem"), pems.cert);
    fs.writeFileSync(path.join(__dirname, "certs", "key.pem"), pems.private);

    return {
      key: pems.private,
      cert: pems.cert
    };
  }
}

//======================================================================
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

//======================================================================
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
    if (!name) {
      return false;
    }

    return deps.some(depName => name.startsWith(depName));
  };
}

//======================================================================
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

//======================================================================
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

  // dev.reticulum.io doesn't run ita
  if (host === "dev.reticulum.io") {
      return appConfig;
  }

  const hubsConfigsResponse = await fetch(`https://${host}/api/ita/configs/hubs`, { headers });

  const hubsConfigs = await hubsConfigsResponse.json();

  if (!hubsConfigsResponse.ok) {
    throw new Error(`Error fetching Hubs Cloud config "${hubsConfigsResponse.statusText}"`);
  }

  const { shortlink_domain, thumbnail_server } = hubsConfigs.general;

  const localIp = process.env.HOST_IP || (await internalIpV4()) || "localhost";

  process.env.RETICULUM_SERVER = host;
  process.env.SHORTLINK_DOMAIN = shortlink_domain;
  process.env.CORS_PROXY_SERVER = `${localIp}:8080/cors-proxy`;
  process.env.THUMBNAIL_SERVER = thumbnail_server;
  process.env.NON_CORS_PROXY_DOMAINS = `${localIp},localhost,localhost`;

  return appConfig;
}

//======================================================================
function htmlPagePlugin({ filename, extraChunks = [], chunksSortMode, inject }) {
  const chunkName = filename.match(/(.+).html/)[1];
  const options = {
    filename,
    template: path.join(__dirname, "src", filename),
    favicon: './admin/src/assets/images/favicon.ico',
    chunks: [...extraChunks, chunkName],
    minify: {
      removeComments: true
    }
  };

  if (chunksSortMode) options.chunksSortMode = chunksSortMode;
  if (inject) options.inject = inject;

  return new HTMLWebpackPlugin(options);
}

//======================================================================
// MODULE EXPORTS
//======================================================================
export default async (env, argv) => {
  env = env || {};

  // Load environment variables from .env files.
  // .env takes precedent over .defaults.env
  // Previously defined environment variables are not overwritten
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  let appConfig = createDefaultAppConfig();

  const localHost = "localhost";

  Object.assign(process.env, {
    HOST: localHost,
    RETICULUM_SOCKET_SERVER: localHost,
    CORS_PROXY_SERVER: "localhost:4000",
    NON_CORS_PROXY_DOMAINS: `${localHost},pet-mom.club,www.pet-mom.club`,
    BASE_ASSETS_PATH: `https://${localHost}:8080/`,
    RETICULUM_SERVER: `${localHost}:4000`,
    POSTGREST_SERVER: "",
    ITA_SERVER: "",
    UPLOADS_HOST: `https://${localHost}:4000`
  });

  // In production, the environment variables are defined in CI or loaded from ita and
  // the app config is injected into the head of the page by Reticulum.
  const host = "localhost";
  const liveReload = !!process.env.LIVE_RELOAD || false;

  const legacyBabelConfig = {
    presets: ["@babel/react", ["@babel/env", { targets: { ie: 11 } }]],
    plugins: [
      "@babel/proposal-object-rest-spread",
      "@babel/plugin-transform-async-to-generator",
      "@babel/plugin-proposal-optional-chaining",
      ["@babel/proposal-class-properties", { "loose": true }],
      ["@babel/plugin-proposal-private-methods", { "loose": true }],
      ["@babel/plugin-proposal-private-property-in-object", { "loose": true }]
    ]
  };

  const devServerHeaders = {
    "Access-Control-Allow-Origin": "*"
  };

  // Behind and environment var for now pending further testing
  if (process.env.DEV_CSP_SOURCE) {
    const CSPResp = await fetch(`https://${process.env.DEV_CSP_SOURCE}/`);
    const remoteCSP = CSPResp.headers.get("content-security-policy");
    devServerHeaders["content-security-policy"] = remoteCSP;
    // .replaceAll("connect-src", "connect-src https://example.com");
  }

  return {
    watch: false,
    node: {
      // need to specify this manually because some random lodash code will try to access
      // Buffer on the global object if it exists, so webpack will polyfill on its behalf
      //Buffer: false,
      //fs: "empty"
    },
    stats: {
      children: true,
    },
    resolve: {
      fallback: {
        fs: false,
        path: require.resolve("path-browserify")
      }
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
      //public: `${host}:8080`,
      //useLocalIp: true,
      allowedHosts: [host, "localhost", "pet-mom.club", "www.pet-mom.club", "reticulum.pet-mom.club","hubs.pet-mom.club","admin.pet-mom.club","dialog.pet-mom.club"],
      headers: devServerHeaders,
      hot: liveReload,
      //inline: true,
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
      onBeforeSetupMiddleware: function (devServer) {
        // Local CORS proxy
        devServer.app.all("/cors-proxy/*", (req, res) => {
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
            res.header("Location", "https://location:8080/cors-proxy/" + redirectLocation);
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

        // be flexible with people accessing via a local reticulum on another port
        //TODO; SOOSKIM
        devServer.app.use(cors({ origin: ['/localhost(:\d*)?$/', '/hubs\.local(:\d*)?$/'] }));
        // networked-aframe makes HEAD requests to the server for time syncing. Respond with an empty body.
        devServer.app.head("*", function(req, res, next) {
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
            //TODO; SOOSKIM ! - attrs: ["img:src", "a-asset-item:src", "audio:src", "source:src"]
          }
        },
        {
          test: /\.worker\.js$/,
          loader: "worker-loader",
          options: {
            filename: "assets/js/[name]-[contenthash].js",
            publicPath: "/",
            inline: "fallback"
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
        // Some JS assets are loaded at runtime and should be coppied unmodified and loaded using file-loader
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
          // Exclude JS assets in node_modules because they are already transformed and often big.
          exclude: [path.resolve(__dirname, "node_modules")],
          loader: "babel-loader"
        },
        {
          test: /\.(scss|css)$/,
          use: [
            "style-loader",
            // {
            //   loader: MiniCssExtractPlugin.loader
            // },
            {
              loader: "css-loader",
              options: {
                //TODO; SOOSKIM ! - name: "[path][name]-[hash].[ext]",
                esModule: false,
                modules: {
                  mode: "local",
                  auto: true,
                  exportGlobals: true,
                  namedExport: true,
                  localIdentName: "[path][name]-[hash]",
                  localIdentContext: path.resolve(__dirname, "src"),
                  exportLocalsConvention: "camelCase",
                  exportOnlyLocals: false,
                }
              }
            },
            {
              loader: "sass-loader",
              options: {
                api: "legacy",
                // implementation: require('node-sass'),
                // sassOptions: {
                //   // Your sass options
                // },
              },
            },
          ]
        },
        {
          test: /\.svg$/i,
          include: [path.resolve(__dirname, "src", "react-components")],
          issuer: { and: [ /\.(js|ts|jsx|tsx)x?$/ ] },
          use: [
            {
              loader: "@svgr/webpack",
              options: {
                titleProp: true,
                replaceAttrValues: { "#000": "{props.color}" },
                template: defaultTemplate,
                svgoConfig: {
                  plugins: [
                    {name:'removeViewBox', active: false},
                    {name:'mergePaths', active: false},
                    {name:'convertShapeToPath', active: false},
                    {name:'removeHiddenElems', active: false}
                  ]
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
              // move required assets to output dir and add a hash for cache busting
              name: "[path][name]-[hash].[ext]",
              // Make asset paths relative to /src
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
        }
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
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "./admin/src/assets/images/favicon.ico",
            to: "favicon.ico"
          }
        ]}
      ),
      // new FaviconsWebpackPlugin('./admin/src/assets/images/favicon.ico'),
      // Each output page needs a HTMLWebpackPlugin entry
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
      new CopyWebpackPlugin({ patterns:[
        {
          from: "src/hub.service.js",
          to: "hub.service.js"
        }
      ]}),
      new CopyWebpackPlugin({ patterns: [
        {
          from: "src/schema.toml",
          to: "schema.toml"
        }
      ]}),
      new MiniCssExtractPlugin({
        filename: "assets/stylesheets/[name]-[contenthash].css",
      }),
      new webpack.DefinePlugin({
        "process.env": JSON.stringify({
          NODE_ENV: argv.mode,
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
