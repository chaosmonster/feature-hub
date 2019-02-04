import {join} from 'path';
import {Configuration} from 'webpack';
import {webpackBaseConfig} from '../webpack-base-config';

const featureAppConfig: Configuration = {
  ...webpackBaseConfig,
  entry: join(__dirname, './feature-app-outer.tsx'),
  externals: {
    react: 'react',
    '@feature-hub/react': '@feature-hub/react'
  }
};

export default [
  {
    ...featureAppConfig,
    output: {
      filename: 'feature-app.umd.js',
      libraryTarget: 'umd',
      publicPath: '/'
    }
  },
  {
    ...featureAppConfig,
    output: {
      filename: 'feature-app.commonjs.js',
      libraryTarget: 'commonjs2',
      publicPath: '/'
    },
    target: 'node'
  },
  {
    ...webpackBaseConfig,
    entry: join(__dirname, './integrator.tsx'),
    output: {
      filename: 'integrator.js',
      publicPath: '/'
    }
  }
] as Configuration[];