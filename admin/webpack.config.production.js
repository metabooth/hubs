const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");
const webpack = require("webpack");
const cors = require("cors");
const HTMLWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

function createHTTPSConfig() {
    return {
      key: "/home/lonycell/server/.certs/pet-mom.club/cert.pem",
      key: "/home/lonycell/server/.certs/pet-mom.club/key.pem",
    };
}

module.exports = (env, argv) => {
  env = env || {};

  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  const domain = "www.pet-mom.club";
  const port = 8989;
  Object.assign(process.env, {
    HOST: domain,
    RETICULUM_SOCKET_SERVER: domain,
    CORS_PROXY_SERVER: domain,
    NON_CORS_PROXY_DOMAINS: `${domain}`,
    BASE_ASSETS_PATH: `https://${domain}:8989/`,
    RETICULUM_SERVER: domain,
    POSTGREST_SERVER: domain,
    ITA_SERVER: domain,
    HOST_IP: domain,
  });

  const defaultHostName = 'www.pet-mom.club';
  const host = process.env.HOST_IP || defaultHostName;

  // Remove comments from .babelrc
  const babelConfig = JSON.parse(
    fs
      .readFileSync(path.resolve(__dirname, ".babelrc"))
      .toString()
      .replace(/\/\/.+/g, "")
  );

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
      alias: {
        process: "process/browser"
      },
      fallback: {
        fs: false,
        path: require.resolve("path-browserify"),
      }
    },
    entry: {
      admin: path.join(__dirname, "src", "admin.js")
    },
    output: {
      path: path.resolve(__dirname, './dist'),
      filename: "assets/js/[name]-[chunkhash].js",
      publicPath: process.env.BASE_ASSETS_PATH || ""
    },
    devtool: argv.mode === "production" ? "source-map" : "inline-source-map",
    devServer: {
      server: {
        type: 'https',
        options: createHTTPSConfig(),
      },
      host: process.env.HOST_IP || "0.0.0.0",
      port: process.env.PORT || "8989",
      allowedHosts: 'all',
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      onBeforeSetupMiddleware: function (devServer) {
        if (!devServer) {
          throw new Error('webpack-dev-server is not defined');
        }
  
        devServer.app.use(cors({ origin: /www\.pet-mom\.club(:\d*)?$/ }));
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
            publicPath: "/",
            filename: "assets/js/[name]-[contenthash].js",
            publicPath: "/",
            inline: "fallback"
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
          test: /\.ico$/i,
          type: "asset/resource",
          generator: {
              filename: "[name][ext][query]"
          }
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
      new webpack.ProvidePlugin({
        process: 'process/browser',
      }),
      new CleanWebpackPlugin(),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "src/assets/images/favicon.ico",
            to: "favicon.ico"
          }
        ]}
      ),
      new HTMLWebpackPlugin({
        filename: "admin.html",
        template: path.join(__dirname, "src", "admin.html"),
        favicon: "src/assets/images/favicon.ico",
        inject: "head",
      }),
      new MiniCssExtractPlugin({
        filename: "assets/stylesheets/[name]-[contenthash].css",
      }),
      new webpack.ProvidePlugin({
        "process.env": JSON.stringify({
          NODE_ENV: 'production',
          SHORTLINK_DOMAIN: process.env.SHORTLINK_DOMAIN,
          RETICULUM_SERVER: 'www.pet-mom.club:4000',
          RETICULUM_SOCKET_SERVER: 'www.pet-mom.club:4000',
          THUMBNAIL_SERVER: 'www.pet-mom.club:8080',
          CORS_PROXY_SERVER: 'www.pet-mom.club:8080',
          NON_CORS_PROXY_DOMAINS: 'pet-mom.club',
          BUILD_VERSION: '1.0.0',
          SENTRY_DSN: process.env.SENTRY_DSN,
          GA_TRACKING_ID: process.env.GA_TRACKING_ID,
          POSTGREST_SERVER: 'www.pet-mom.club:3001',
          UPLOADS_HOST: 'www.pet-mom.club:8080',
          BASE_ASSETS_PATH: '',
          CONFIGURABLE_SERVICES: process.env.CONFIGURABLE_SERVICES,
          ITA_SERVER: process.env.ITA_SERVER
        })
      })
    ]
  };
};



