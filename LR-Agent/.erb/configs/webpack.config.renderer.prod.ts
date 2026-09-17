/**
 * Build config for electron renderer process
 */

import path from 'path';
import webpack from 'webpack';
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin';
import type { EditorLanguage } from 'monaco-editor/esm/metadata';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import CssMinimizerPlugin from 'css-minimizer-webpack-plugin';
import { merge } from 'webpack-merge';
import TerserPlugin from 'terser-webpack-plugin';
import baseConfig from './webpack.config.base';
import webpackPaths from './webpack.paths';
import checkNodeEnv from '../scripts/check-node-env';
import deleteSourceMaps from '../scripts/delete-source-maps';
import { buildRendererCsp, themeInitScript } from './rendererCsp';

checkNodeEnv('production');
deleteSourceMaps();

const configuration: webpack.Configuration = {
  devtool: 'source-map',

  mode: 'production',

  target: ['web', 'electron-renderer'],

  entry: [path.join(webpackPaths.srcRendererPath, 'index.tsx')],

  output: {
    path: webpackPaths.distRendererPath,
    publicPath: './',
    filename: 'renderer.js',
    library: {
      type: 'umd',
    },
  },

  module: {
    rules: [
      {
        test: /codicon\.css$/,
        include: /node_modules[\\/]@vscode[\\/]codicons/,
        type: 'asset/resource',
        generator: { filename: 'static/codicons/[name][ext]' },
      },
      {
        test: /codicon\.ttf$/,
        include: /node_modules[\\/]@vscode[\\/]codicons/,
        type: 'asset/resource',
        generator: { filename: 'static/codicons/[name][ext]' },
      },
      {
        test: /\.css$/,
        include: /node_modules[\\/]highlight\.js[\\/]styles/,
        type: 'asset/resource',
        generator: { filename: 'static/hljs/[name][ext]' },
      },
      {
        test: /\.s?(a|c)ss$/,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              modules: true,
              sourceMap: true,
              importLoaders: 1,
            },
          },
          'sass-loader',
        ],
        include: /\.module\.s?(c|a)ss$/,
      },
      {
        test: /\.s?(a|c)ss$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader', 'sass-loader'],
        exclude: [
          /\.module\.s?(c|a)ss$/,
          /node_modules[\\/]@vscode[\\/]codicons/,
          /node_modules[\\/]highlight\.js[\\/]styles/,
        ],
      },
      // Fonts
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        exclude: /node_modules[\\/]@vscode[\\/]codicons/,
        type: 'asset/resource',
      },
      // Images
      {
        test: /\.(png|jpg|jpeg|gif)$/i,
        type: 'asset/resource',
      },
      {
        resourceQuery: /url/,
        type: 'asset/resource',
      },
      // SVG
      {
        test: /\.svg$/,
        use: [
          {
            loader: '@svgr/webpack',
            options: {
              prettier: false,
              svgo: false,
              svgoConfig: {
                plugins: [{ removeViewBox: false }],
              },
              titleProp: true,
              ref: true,
            },
          },
          'file-loader',
        ],
      },
    ],
  },

  optimization: {
    minimize: true,
    minimizer: [new TerserPlugin(), new CssMinimizerPlugin()],
  },

  plugins: [
    /**
     * Create global constants which can be configured at compile time.
     *
     * Useful for allowing different behaviour between development builds and
     * release builds
     *
     * NODE_ENV should be production so that modules do not perform certain
     * development checks
     */
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
      DEBUG_PROD: false,
      API_BASE_URL: 'http://localhost:8000/api/v1',
    }),

    new MiniCssExtractPlugin({
      filename: 'style.css',
    }),

    new MonacoWebpackPlugin({
      publicPath: './',
      languages: [
        'javascript',
        'typescript',
        'python',
        'json',
        'markdown',
        'yaml',
        'sql',
        'cpp',
        'csharp',
        'go',
        'rust',
        'java',
        'html',
        'xml',
        'shell',
        'css',
        'scss',
        'less',
        'php',
        'ruby',
        'swift',
        'kotlin',
        'dockerfile',
        'ini',
        'powershell',
        'bat',
        'lua',
        'r',
        'perl',
        'restructuredtext',
        // plaintext 不在 monaco metadata 的 EditorLanguage 联合内，运行时仍支持
        'plaintext' as EditorLanguage,
      ],
    }),

    new BundleAnalyzerPlugin({
      analyzerMode: process.env.ANALYZE === 'true' ? 'server' : 'disabled',
      analyzerPort: 8889,
    }),

    new HtmlWebpackPlugin({
      filename: 'index.html',
      template: path.join(webpackPaths.srcRendererPath, 'index.ejs'),
      minify: {
        collapseWhitespace: true,
        removeAttributeQuotes: true,
        removeComments: true,
        // 不压缩内联脚本：CSP 的 sha256 必须与脚本字节完全一致
        minifyJS: false,
      },
      templateParameters: {
        cspContent: buildRendererCsp(false),
        themeInitScript,
      },
      isBrowser: false,
      isDevelopment: false,
    }),

    new webpack.DefinePlugin({
      'process.type': '"renderer"',
    }),
  ],
};

export default merge(baseConfig, configuration);
