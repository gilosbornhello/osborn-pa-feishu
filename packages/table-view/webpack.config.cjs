// Build the workbench (index.html) and the write self-test (selftest.html) as
// one Feishu Base table-view extension package. Run from ./block (the scripts do this):
// the opdev webpack plugin reads ./block.json and ../app.json from the cwd.
const fs = require("fs");
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const { BitableAppWebpackPlugin, opdevMiddleware } = require("@lark-opdev/block-bitable-webpack-utils");

const isDev = process.env.NODE_ENV === "development";
const workbenchDir = path.resolve(__dirname, "../workbench");

// Reuse the workbench page markup; drop its own stylesheet and script tags.
function pageMarkup(file) {
  const html = fs.readFileSync(path.join(workbenchDir, file), "utf8")
    .replace(/<link rel="stylesheet"[^>]*>\n?/g, "")
    .replace(/<script type="module"[^>]*><\/script>\n?/g, "");
  if (/<script|<link rel="stylesheet"/.test(html)) throw new Error(`${file}: unexpected script or stylesheet tag left`);
  return html;
}

module.exports = {
  entry: {
    workbench: path.resolve(__dirname, "block/src/workbench-entry.js"),
    selftest: path.resolve(__dirname, "block/src/selftest-entry.js"),
  },
  mode: isDev ? "development" : "production",
  devtool: isDev ? "inline-source-map" : false,
  stats: "errors-warnings",
  output: {
    path: path.resolve(__dirname, "block/dist"),
    clean: true,
    publicPath: isDev ? "/block/" : "./",
  },
  module: {
    rules: [{ test: /\.css$/, use: [isDev ? "style-loader" : MiniCssExtractPlugin.loader, "css-loader"] }],
  },
  plugins: [
    ...(isDev ? [] : [new MiniCssExtractPlugin()]),
    new BitableAppWebpackPlugin({ open: false }),
    new HtmlWebpackPlugin({ filename: "index.html", chunks: ["workbench"], templateContent: pageMarkup("index.html"), publicPath: isDev ? "/block/" : "./" }),
    new HtmlWebpackPlugin({ filename: "selftest.html", chunks: ["selftest"], templateContent: pageMarkup("selftest.html"), publicPath: isDev ? "/block/" : "./" }),
  ],
  performance: { hints: false },
  devServer: isDev ? {
    port: 8080,
    hot: false,
    client: { logging: "error" },
    setupMiddlewares: (middlewares, devServer) => { middlewares.push(opdevMiddleware(devServer)); return middlewares; },
  } : undefined,
};
