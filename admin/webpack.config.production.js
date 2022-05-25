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

//==========================================================================================
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

//==========================================================================================
module.exports = (env, argv) => {
  env = env || {};
 
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  const defaultHostName = 'www.pet-mom.club';
  const host = process.env.HOST_IP || defaultHostName;
  const port = 4000;
  const serviceHost = `${host}:4000`;

  const domain = "www.pet-mom.club";
  Object.assign(process.env, {
    HOST: domain,
    RETICULUM_SOCKET_SERVER: serviceHost,
    CORS_PROXY_SERVER: serviceHost,
    NON_CORS_PROXY_DOMAINS: `${domain}`,
    BASE_ASSETS_PATH: `https://${domain}:8989/`,
    RETICULUM_SERVER: serviceHost,
    POSTGREST_SERVER: `${host}:3001`,
    ITA_SERVER: serviceHost,
    HOST_IP: domain,
  });

  const babelConfig = JSON.parse(fs
      .readFileSync(path.resolve(__dirname, ".babelrc"))
      .toString()
      .replace(/\/\/.+/g, "")
  );

  //==========================================================================================
  return {
    watch: false,
    node: {
    },
    stats: {
      children: true,
    },

    //==========================================================================================
    resolve: {
      fallback: {
        fs: false,
        path: require.resolve("path-browserify")
      },
    },
    //==========================================================================================
    entry: {
      admin: path.join(__dirname, "src", "admin.js")
    },

    //==========================================================================================
    output: {
      //TODO: SOOSKIM ! 
      path: path.resolve(__dirname, './dist'),
      filename: "assets/js/[name]-[chunkhash].js",
      publicPath: process.env.BASE_ASSETS_PATH || ""
    },

    //==========================================================================================
    devtool: "source-map",

    //==========================================================================================
    devServer: {
      server: {
        type: 'https',
        options: createHTTPSConfig(),
      },
      host: "0.0.0.0",
      port: process.env.PORT || "8989",
      allowedHosts: ["localhost", "hubs.local", "pet-mom.club", "www.pet-mom.club", "reticulum.pet-mom.club","hubs.pet-mom.club","admin.pet-mom.club","dialog.pet-mom.club"],
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      setupMiddlewares: function (middlewares, devServer) {
        if (!devServer) {
          throw new Error('webpack-dev-server is not defined');
        }
  
        devServer.app.use(cors({ origin: ['/host(:\d*)?$/', '/hubs\.local(:\d*)?$/', '/www\.pet-mom\.club(:\d*)?$/'] }));
        devServer.app.head("*", function(req, res, next) {
          if (req.method === "HEAD") {
            res.append("Date", new Date().toGMTString());
            res.send("");
          } else {
            next();
          }
        });

        return middlewares;
      },
    },

    //==========================================================================================
    performance: {
      assetFilter(assetFilename) {
        return !/\.(map|png|jpg|gif|glb|webm)$/.test(assetFilename);
      }
    },

    //==========================================================================================
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
            inline: "fallback"
          }
        },
        {
          test: /\.(scss|css)$/,
          use: [
            "style-loader",
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
                api: "legacy"
              },
            },
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
        }
      ]
    },
    //==========================================================================================
    plugins: [
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
  //==========================================================================================
};
