// Marketplace build of the workbench as a Base sidebar extension:
// one HTML page, one script, one stylesheet, relative paths only (the host
// serves the `output` directory as static files; no rewrite, no CDN).
const fs = require("fs");
const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const page = fs.readFileSync(path.resolve(__dirname, "../workbench/index.html"), "utf8")
  .replace(/<link rel="stylesheet"[^>]*>\n?/g, "")
  .replace(/<script type="module"[^>]*><\/script>\n?/g, "");
if (/<script|<link rel="stylesheet"/.test(page)) throw new Error("index.html: unexpected script or stylesheet tag left");

module.exports = {
  mode: "production",
  entry: path.resolve(__dirname, "src/entry.js"),
  output: { path: path.resolve(__dirname, "dist"), filename: "workbench.js", publicPath: "./", clean: true },
  module: { rules: [{ test: /\.css$/, use: [MiniCssExtractPlugin.loader, "css-loader"] }] },
  plugins: [
    new MiniCssExtractPlugin({ filename: "workbench.css" }),
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    new HtmlWebpackPlugin({ filename: "index.html", templateContent: page, publicPath: "./", scriptLoading: "defer" }),
  ],
  performance: { hints: false },
  devtool: false,
};
