// This file contains helpers for running operations in REST format.
// The goal is that handlers that explicitly handle an express route
// should just be shallow wrappers around things in this file, but
// these functions should not explicitly depend on the request
// object.
// This means that one of these handlers can support multiple
// routes. That's useful for the routes that do really similar
// things.

var Parse = require('parse/node').Parse;
import Auth from './Auth';

var RestQuery = require('./RestQuery');
var RestWrite = require('./RestWrite');
var triggers = require('./triggers');

function checkTriggers(className, config, types) {
  return types.some((triggerType) => {
    return triggers.getTrigger(className, triggers.Types[triggerType], config.applicationId);
  });
}

function checkLiveQuery(className, config) {
  return config.liveQueryController && config.liveQueryController.hasLiveQuery(className)
}

function generateRandomString(length) {
	var chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	var result = "";
	for (var i = length; i > 0; --i) result += chars[Math.round(Math.random() * (chars.length - 1))];
	return result;
}

// Returns a promise for an object with optional keys 'results' and 'count'.
function find(config, auth, className, restWhere, restOptions, clientSDK, httpRequest) {
  enforceRoleSecurity('find', className, auth);
  var randomString = generateRandomString(5);
  return triggers.maybeRunQueryTrigger(triggers.Types.beforeFind, className, restWhere, restOptions, config, auth, false, randomString).then((result) => {
    restWhere = result.restWhere || restWhere;
    restOptions = result.restOptions || restOptions;
    const query = new RestQuery(config, auth, className, restWhere, restOptions, clientSDK, httpRequest);
    return query.execute(undefined, randomString);
  });
}

// get is just like find but only queries an objectId.
const get = (config, auth, className, objectId, restOptions, clientSDK, httpRequest) => {
  var restWhere = { objectId };
  enforceRoleSecurity('get', className, auth);
  return triggers.maybeRunQueryTrigger(triggers.Types.beforeFind, className, restWhere, restOptions, config, auth, true, randomString).then((result) => {
    restWhere = result.restWhere || restWhere;
    restOptions = result.restOptions || restOptions;
    const query = new RestQuery(config, auth, className, restWhere, restOptions, clientSDK, httpRequest);
    return query.execute(undefined, randomString);
  });
}

// Returns a promise that doesn't resolve to any useful value.
function del(config, auth, className, objectId) {
  if (typeof objectId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_JSON,
      'bad objectId');
  }

  if (className === '_User' && !auth.couldUpdateUserId(objectId)) {
    throw new Parse.Error(Parse.Error.SESSION_MISSING,
      'insufficient auth to delete user');
  }

  enforceRoleSecurity('delete', className, auth);

  var inflatedObject;

  return Promise.resolve().then(() => {
    const hasTriggers = checkTriggers(className, config, ['beforeDelete', 'afterDelete']);
    const hasLiveQuery = checkLiveQuery(className, config);
    if (hasTriggers || hasLiveQuery || className == '_Session') {
      return find(config, Auth.master(config), className, {objectId: objectId})
        .then((response) => {
          if (response && response.results && response.results.length) {
            const firstResult = response.results[0];
            firstResult.className = className;
            if (className === '_Session' && !auth.isMaster) {
              if (!auth.user || firstResult.user.objectId !== auth.user.id) {
                throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'invalid session token');
              }
            }
            var cacheAdapter = config.cacheController;
            cacheAdapter.user.del(firstResult.sessionToken);
            inflatedObject = Parse.Object.fromJSON(firstResult);
            // Notify LiveQuery server if possible
            config.liveQueryController.onAfterDelete(inflatedObject.className, inflatedObject);
            return triggers.maybeRunTrigger(triggers.Types.beforeDelete, auth, inflatedObject, null,  config);
          }
          throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND,
            'Object not found for delete.');
        });
    }
    return Promise.resolve({});
  }).then(() => {
    if (!auth.isMaster) {
      return auth.getUserRoles();
    } else {
      return;
    }
  }).then(() => {
    var options = {};
    if (!auth.isMaster) {
      options.acl = ['*'];
      if (auth.user) {
        options.acl.push(auth.user.id);
        options.acl = options.acl.concat(auth.userRoles);
      }
    }

    return config.database.destroy(className, {
      objectId: objectId
    }, options);
  }).then(() => {
    return triggers.maybeRunTrigger(triggers.Types.afterDelete, auth, inflatedObject, null, config);
  });
}

// Returns a promise for a {response, status, location} object.
function create(config, auth, className, restObject, clientSDK, httpRequest) {
  enforceRoleSecurity('create', className, auth);
  var write = new RestWrite(config, auth, className, null, restObject, null, clientSDK, httpRequest);
  return write.execute();
}

// Returns a promise that contains the fields of the update that the
// REST API is supposed to return.
// Usually, this is just updatedAt.
function update(config, auth, className, restWhere, restObject, clientSDK, httpRequest) {
  enforceRoleSecurity('update', className, auth);

  return Promise.resolve().then(() => {
    const hasTriggers = checkTriggers(className, config, ['beforeSave', 'afterSave']);
    const hasLiveQuery = checkLiveQuery(className, config);
    if (hasTriggers || hasLiveQuery) {
      return find(config, Auth.master(config), className, restWhere);
    }
    return Promise.resolve({});
  }).then((response) => {
    var originalRestObject;
    if (response && response.results && response.results.length) {
      originalRestObject = response.results[0];
    }

    var write = new RestWrite(config, auth, className, restWhere, restObject, originalRestObject, clientSDK, httpRequest);
    return write.execute();
  });
}

const classesWithMasterOnlyAccess = ['_JobStatus', '_PushStatus', '_Hooks', '_GlobalConfig', '_JobSchedule'];
// Disallowing access to the _Role collection except by master key
function enforceRoleSecurity(method, className, auth) {
  if (className === '_Installation' && !auth.isMaster) {
    if (method === 'delete' || method === 'find') {
      const error = `Clients aren't allowed to perform the ${method} operation on the installation collection.`
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
    }
  }

  //all volatileClasses are masterKey only
  if(classesWithMasterOnlyAccess.indexOf(className) >= 0 && !auth.isMaster){
    const error = `Clients aren't allowed to perform the ${method} operation on the ${className} collection.`
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  }
}

module.exports = {
  create,
  del,
  find,
  get,
  update
};
