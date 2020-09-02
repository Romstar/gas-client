import { v4 as uuidv4 } from 'uuid';
import { AllowedDevelopmentDomains, ServerConfig } from './types/config';
import { ServerFunctions, ServerFunctionsMap } from './types/functions';

/**
 * Util that returns true if allowedDevelopmentDomains matches origin
 * @param {string|function} allowedDevelopmentDomains either a string of space-separated allowed subdomains or a function that accepts the origin as an argument and returns true if permitted
 * @param {string} origin the target origin subdomain to compare against
 */
const checkAllowList = (
  allowedDevelopmentDomains: AllowedDevelopmentDomains | undefined,
  origin: string
) => {
  if (typeof allowedDevelopmentDomains === 'string') {
    return allowedDevelopmentDomains
      .split(' ')
      .some((permittedOrigin) => permittedOrigin === origin);
  }
  if (typeof allowedDevelopmentDomains === 'function') {
    return allowedDevelopmentDomains(origin) === true;
  }
  return false;
};

export default class Server<F extends ServerFunctionsMap = {}> {
  private _serverFunctions: ServerFunctions<F> = {} as ServerFunctions<F>;

  /**
   * Accepts a single `config` object
   * @param {object} [_config] An optional config object for use in development.
   * @param {string|function} [config.allowedDevelopmentDomains] An optional config to specify which domains are permitted for communication with Google Apps Script Webpack Dev Server development tool. This is a security setting, and if not specified, this will block functionality in development. Will accept either a space-separated string of allowed subdomains, e.g. `https://localhost:3000 http://localhost:3000` (notice no trailing slash); or a function that takes in the requesting origin should return `true` to allow communication, e.g. `(origin) => /localhost:\d+$/.test(origin)`
   */
  constructor(private _config?: ServerConfig) {
    // skip the reserved names: https://developers.google.com/apps-script/guides/html/reference/run
    const ignoredFunctionNames = [
      'withFailureHandler',
      'withLogger',
      'withSuccessHandler',
      'withUserObject',
    ];

    try {
      // get the names of all of our publicly accessible server functions
      this._serverFunctions = Object.keys(google.script.run).reduce(
        (acc, functionName) =>
          // filter out the reserved names -- we don't want those
          ignoredFunctionNames.includes(functionName)
            ? acc
            : {
                // attach Promise-based functions to the serverFunctions property
                ...acc,
                [functionName]: (...args: unknown[]) =>
                  new Promise((resolve, reject) => {
                    google.script.run
                      .withSuccessHandler(resolve)
                      .withFailureHandler(reject)
                      [functionName](...args);
                  }),
              },
        {} as ServerFunctions<F>
      );
    } catch (err) {
      if (
        err.toString() === 'ReferenceError: google is not defined' &&
        process?.env.NODE_ENV === 'development'
      ) {
        // we'll store and access the resolve/reject functions here by id
        window.gasStore = {};

        // set up the message 'receive' handler
        const receiveMessageHandler = (event: MessageEvent) => {
          const allowedDevelopmentDomains = this._config
            ?.allowedDevelopmentDomains;

          // check the allow list for the receiving origin
          const allowOrigin = checkAllowList(
            allowedDevelopmentDomains,
            event.origin
          );
          if (!allowOrigin) return;

          // we only care about the type: 'RESPONSE' messages here
          if (event.data.type !== 'RESPONSE') return;

          const { response, status, id } = event.data;

          // look up the saved resolve and reject funtions in our global store based
          // on the response id, and call the function depending on the response status
          const { resolve, reject } = window.gasStore[id];

          if (status === 'ERROR') {
            reject(response);
          }
          resolve(response);
        };

        window.addEventListener('message', receiveMessageHandler, false);

        const handler = {
          get(target: unknown, functionName: string) {
            const id = uuidv4();
            const promise = new Promise((resolve, reject) => {
              // store the new Promise's resolve and reject
              window.gasStore[id] = { resolve, reject };
            });
            return (...args: unknown[]) => {
              // https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
              window.parent.postMessage(
                {
                  type: 'REQUEST',
                  id,
                  functionName,
                  args: [...args],
                },
                // only send messages to our dev server, which should be running on the same origin
                window.location.origin
              );
              return promise;
            };
          },
        };
        this._serverFunctions = new Proxy({}, handler) as ServerFunctions<F>;
      }
    }
  }

  get serverFunctions(): ServerFunctions<F> {
    return this._serverFunctions;
  }
}