const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");
const webpack = require("webpack");
const cors = require("cors");
const HTMLWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

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

module.exports = (env, argv) => {
  env = env || {};

  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  const mainHost = "www.pet-mom.club";
  const host = process.env.HOST_IP || mainHost;
  const port = process.env.HOST_PORT || "8989";

  Object.assign(process.env, {
    HOST: mainHost,
    RETICULUM_SOCKET_SERVER: mainHost,
    CORS_PROXY_SERVER: ``,
    NON_CORS_PROXY_DOMAINS: `${mainHost}, raw.githubusercontent.com, hubs-proxy.com`,
    BASE_ASSETS_PATH: `/admin-origin/`,
    RETICULUM_SERVER: `${mainHost}`,
    POSTGREST_SERVER: ``,
    ITA_SERVER: ``,
    UPLOADS_HOST: ``
  });

  const babelConfig = JSON.parse(
    fs
      .readFileSync(path.resolve(__dirname, ".babelrc"))
      .toString()
      .replace(/\/\/.+/g, "")
  );

  return {
    node: {
      fs: "empty"
    },
    entry: {
      admin: path.join(__dirname, "src", "admin.js")
    },
    output: {
      filename: "assets/js/[name]-[chunkhash].js",
      publicPath: process.env.BASE_ASSETS_PATH || ""
    },
    devtool: argv.mode === "production" ? "source-map" : "inline-source-map",
    devServer: {
      https: createHTTPSConfig(),
      host: "0.0.0.0",
      public: `${host}:${port}`,
      useLocalIp: true,
      allowedHosts: [`${host}`, "*"],
      static: './dist',
      useLocalIp: true,
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      // before: function(app) {
      //   app.all("/cors-proxy/*", (req, res) => {
      //     res.header("Access-Control-Allow-Origin", "*");
      //     res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      //     res.header("Access-Control-Allow-Headers", "Range");
      //     res.header(
      //       "Access-Control-Expose-Headers",
      //       "Accept-Ranges, Content-Encoding, Content-Length, Content-Range, Hub-Name, Hub-Entity-Type"
      //     );
      //     res.header("Vary", "Origin");
      //     res.header("X-Content-Type-Options", "nosniff");

      //     const redirectLocation = req.header("location");

      //     if (redirectLocation) {
      //       res.header("Location", "https://${host}:${port}/cors-proxy/" + redirectLocation);
      //     }

      //     if (req.method === "OPTIONS") {
      //       res.send();
      //     } else {
      //       const url = req.originalUrl.replace("/cors-proxy/", "");
      //       request({ url, method: req.method }, error => {
      //         if (error) {
      //           console.error(`cors-proxy: error fetching "${url}"\n`, error);
      //           return;
      //         }
      //       }).pipe(res);
      //     }
      //   });

      //   app.use(cors({ origin: /www\.pet-mom\.club(:\d*)?$/ }));
      //   app.head("*", function(req, res, next) {
      //     if (req.method === "HEAD") {
      //       res.append("Date", new Date().toGMTString());
      //       res.send("");
      //     } else {
      //       next();
      //     }
      //   });
      // }
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
          loader: "html-loader"
        },
        {
          test: /\.js$/,
          loader: "babel-loader",
          options: babelConfig,
          exclude: function(modulePath) {
            return /node_modules/.test(modulePath) && !/node_modules\/hubs/.test(modulePath);
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
          test: /\.(glsl|frag|vert)$/,
          use: { loader: "raw-loader" }
        },
        {
          test: /\.(png|jpg|gif|glb|ogg|mp3|mp4|wav|woff2|svg|webm)$/,
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
        }
      ]
    },
    plugins: [
      new HTMLWebpackPlugin({
        filename: "admin.html",
        template: path.join(__dirname, "src", "admin.html")
      }),
      new CopyWebpackPlugin([
        {
          from: "src/assets/images/favicon.ico",
          to: "favicon.ico"
        }
      ]),
      new MiniCssExtractPlugin({
        filename: "assets/stylesheets/[name]-[contenthash].css",
        disable: argv.mode !== "production"
      }),
      new webpack.DefinePlugin({
        "process.env": JSON.stringify({
          NODE_ENV: argv.mode,
          BUILD_VERSION: process.env.BUILD_VERSION,
          CONFIGURABLE_SERVICES: process.env.CONFIGURABLE_SERVICES,
          ITA_SERVER: process.env.ITA_SERVER,
          RETICULUM_SERVER: process.env.RETICULUM_SERVER,
          CORS_PROXY_SERVER: process.env.CORS_PROXY_SERVER,
          POSTGREST_SERVER: process.env.POSTGREST_SERVER,
          UPLOADS_HOST: process.env.UPLOADS_HOST,
          BASE_ASSETS_PATH: process.env.BASE_ASSETS_PATH
        })
      })
    ]
  };
};
