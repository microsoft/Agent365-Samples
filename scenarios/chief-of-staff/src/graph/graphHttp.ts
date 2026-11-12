// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import axios, { AxiosRequestConfig } from 'axios';

export const GRAPH_REQUEST_TIMEOUT_MS = 30_000;

function boundedConfig(config: AxiosRequestConfig = {}): AxiosRequestConfig {
  const timeout = config.timeout && config.timeout > 0
    ? Math.min(config.timeout, GRAPH_REQUEST_TIMEOUT_MS)
    : GRAPH_REQUEST_TIMEOUT_MS;
  return {
    ...config,
    timeout,
    // Bound the whole request, including DNS/connect and trickling responses.
    signal: config.signal
      ? AbortSignal.any([config.signal as AbortSignal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  };
}

export const graphHttp = {
  get<T = any>(url: string, config?: AxiosRequestConfig) {
    return axios.get<T>(url, boundedConfig(config));
  },
  post<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return axios.post<T>(url, data, boundedConfig(config));
  },
  patch<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return axios.patch<T>(url, data, boundedConfig(config));
  },
};
