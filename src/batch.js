const Parse = require('parse/node').Parse;
const url = require('url');
const path = require('path');
// These methods handle batch requests.
const batchPath = '/batch';

// Mounts a batch-handler onto a PromiseRouter.
function mountOnto(router) {
  router.route('POST', batchPath, (req) => {
    return handleBatch(router, req);
  });
}

function parseURL(URL) {
  if (typeof URL === 'string') {
    return url.parse(URL)
  }
  return undefined;
}

function makeBatchRoutingPathFunction(originalUrl, rawServerURL, rawPublicServerURL) {

  const serverURL = rawServerURL ? parseURL(rawServerURL) : parseURL("/1");
  const publicServerURL = rawPublicServerURL ? parseURL(rawPublicServerURL) : parseURL("/1");

  return function (requestPath) {
    const apiPrefix = serverURL.path;

    if (!requestPath) {
      throw new Parse.Error(Parse.Error.INVALID_JSON, 'Batch request is missing requestPath.');
    }
    else if(requestPath.indexOf(apiPrefix) == -1){
      throw new Parse.Error(Parse.Error.INVALID_JSON, 'Batch request issued to wrong API version. Bad URL: '+requestPath+', expected api prefix: '+apiPrefix);
    }
    else {
      //Support for URLs:
      //  - /1/classes/Class
      //  - https://test.insidemaps.com/parse/1/classes/Class
      //  - http://127.0.0.1:1337/1/classes/Class
      return requestPath.substring(requestPath.indexOf(apiPrefix)+apiPrefix.length);
    }
  }
}

// Returns a promise for a {response} object.
// TODO: pass along auth correctly
function handleBatch(router, req) {
  if (!Array.isArray(req.body.requests)) {
    throw new Parse.Error(Parse.Error.INVALID_JSON,
      'requests must be an array');
  }

  // The batch paths are all from the root of our domain.
  // That means they include the API prefix, that the API is mounted
  // to. However, our promise router does not route the api prefix. So
  // we need to figure out the API prefix, so that we can strip it
  // from all the subrequests.
  if (!req.originalUrl.endsWith(batchPath)) {
    throw 'internal routing problem - expected url to end with batch';
  }

  const makeRoutablePath = makeBatchRoutingPathFunction(req.originalUrl, req.config.serverURL, req.config.publicServerURL);

  const promises = req.body.requests.map((restRequest) => {
    const routablePath = makeRoutablePath(restRequest.path);
    // Construct a request that we can send to a handler
    const request = {
      body: restRequest.body,
      config: req.config,
      auth: req.auth,
      info: req.info
    };

    return router.tryRouteRequest(restRequest.method, routablePath, request).then((response) => {
      return { success: response.response };
    }, (error) => {
      return { error: { code: error.code, error: error.message } };
    });
  });

  return Promise.all(promises).then((results) => {
    return { response: results };
  });
}

module.exports = {
  mountOnto,
  makeBatchRoutingPathFunction
};
