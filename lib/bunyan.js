/*
 * Copyright 2012 (c) Trent Mick. All rights reserved.
 */

var VERSION = "0.3.1";

// Bunyan log format version. This becomes the 'v' field on all log records.
// `0` is until I release a version "1.0.0" of node-bunyan. Thereafter,
// starting with `1`, this will be incremented if there is any backward
// incompatible change to the log record format. Details will be in
// "CHANGES.md" (the change log).
var LOG_VERSION = 0;


var xxx = function xxx(s) {     // internal dev/debug logging
  var args = ['XX' + 'X: '+s].concat(Array.prototype.slice.call(arguments, 1));
  console.error.apply(this, args);
};
var xxx = function xxx() {};  // uncomment to turn of debug logging


var os = require('os');
var fs = require('fs');
var util = require('util');



//---- Internal support stuff

function objCopy(obj) {
  if (obj === null) {
    return null;
  } else if (Array.isArray(obj)) {
    return obj.slice();
  } else {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
      copy[k] = obj[k];
    });
    return copy;
  }
}

var format = util.format;
if (!format) {
  // If not node 0.6, then use its `util.format`:
  // <https://github.com/joyent/node/blob/master/lib/util.js#L22>:
  var inspect = util.inspect;
  var formatRegExp = /%[sdj%]/g;
  format = function format(f) {
    if (typeof f !== 'string') {
      var objects = [];
      for (var i = 0; i < arguments.length; i++) {
        objects.push(inspect(arguments[i]));
      }
      return objects.join(' ');
    }
  
    var i = 1;
    var args = arguments;
    var len = args.length;
    var str = String(f).replace(formatRegExp, function(x) {
      if (i >= len) return x;
      switch (x) {
        case '%s': return String(args[i++]);
        case '%d': return Number(args[i++]);
        case '%j': return JSON.stringify(args[i++]);
        case '%%': return '%';
        default:
          return x;
      }
    });
    for (var x = args[i]; i < len; x = args[++i]) {
      if (x === null || typeof x !== 'object') {
        str += ' ' + x;
      } else {
        str += ' ' + inspect(x);
      }
    }
    return str;
  };
}



//---- Levels

var TRACE = 1;
var DEBUG = 2;
var INFO = 3;
var WARN = 4;
var ERROR = 5;
var FATAL = 6;

var levelFromName = {
  'trace': TRACE,
  'debug': DEBUG,
  'info': INFO,
  'warn': WARN,
  'error': ERROR,
  'fatal': FATAL
};
var nameFromLevel = [undefined].concat(Object.keys(levelFromName));

function resolveLevel(nameOrNum) {
  var level = (typeof(nameOrNum) === 'string'
      ? levelFromName[nameOrNum]
      : nameOrNum);
  if (! (TRACE <= level && level <= FATAL)) {
    throw new Error('invalid level: ' + nameOrNum);
  }
  return level;
}



//---- Logger class

/**
 * Create a Logger instance.
 *
 * @param options {Object} See documentation for full details. At minimum
 *    this must include a "service" string key. Configuration keys:
 *      - streams: specify the logger output streams. This is an array of
 *        objects of the form:
 *            {
 *              "level": "info",          // optional, "info" default
 *              "stream": process.stdout, // "stream" or "path" is required
 *              "closeOnExit": false      // optional, default depends
 *            }
 *        See README.md for full details.
 *      - `level`: set the level for a single output stream (cannot be used
 *        with `streams`)
 *      - `stream`: the output stream for a logger with just one, e.g.
 *        `process.stdout` (cannot be used with `streams`)
 *      - `serializers`: object mapping log record field names to
 *        serializing functions. See README.md for details.
 *    All other keys are log record fields.
 *
 * An alternative *internal* call signature is used for creating a child:
 *    new Logger(<parent logger>, <child options>[, <child opts are simple>]);
 *
 * @param _childSimple (Boolean) An assertion that the given `_childOptions`
 *    (a) only add fields (no config) and (b) no serialization handling is
 *    required for them. IOW, this is a fast path for frequent child
 *    creation.
 */
function Logger(options, _childOptions, _childSimple) {
  xxx('Logger start:', options)
  if (! this instanceof Logger) {
    return new Logger(options, _childOptions);
  }
  
  // Input arg validation.
  var parent;
  if (_childOptions !== undefined) {
    parent = options;
    options = _childOptions;
    if (! parent instanceof Logger) {
      throw new TypeError('invalid Logger creation: do not pass a second arg');
    }
  }
  if (!options) {
    throw new TypeError('options (object) is required');
  }
  if ((options.stream || options.level) && options.streams) {
    throw new TypeError('cannot mix "streams" with "stream" or "level" options');
  }
  
  // Fast path for simple child creation.
  if (parent && _childSimple) {
    // Single to stream close handling that this child owns none of its
    // streams.
    this._isSimpleChild = true;

    this.level = parent.level;
    this.streams = parent.streams;
    this.serializers = parent.serializers;
    this.fields = parent.fields;
    var names = Object.keys(options);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      this.fields[name] = options[name];
    }
    return;
  }

  // Null values.
  var self = this;
  if (parent) {
    this.level = parent.level;
    this.streams = [];
    for (var i = 0; i < parent.streams.length; i++) {
      var s = objCopy(parent.streams[i]);
      s.closeOnExit = false; // Don't own parent stream.
      this.streams.push(s);
    }
    this.serializers = objCopy(parent.serializers);
    this.fields = objCopy(parent.fields);
  } else {
    this.level = Number.POSITIVE_INFINITY;
    this.streams = [];
    this.serializers = null;
    this.fields = {};
  }
  
  // Helpers
  function addStream(s) {
    s = objCopy(s);

    // Implicit 'type' from other args.
    type = s.type;
    if (!s.type) {
      if (s.stream) {
        s.type = "stream";
      } else if (s.path) {
        s.type = "file"
      }
    }

    if (s.level) {
      s.level = resolveLevel(s.level);
    } else {
      s.level = INFO;
    }
    if (s.level < self.level) {
      self.level = s.level;
    }

    switch (s.type) {
    case "stream":
      if (!s.closeOnExit) {
        s.closeOnExit = false;
      }
      break;
    case "file":
      if (!s.stream) {
        s.stream = fs.createWriteStream(s.path,
          {flags: 'a', encoding: 'utf8'});
        if (!s.closeOnExit) {
          s.closeOnExit = true;
        }
      } else {
        if (!s.closeOnExit) {
          s.closeOnExit = false;
        }
      }
      break;
    default:
      throw new TypeError('unknown stream type "' + s.type + '"');
    }

    self.streams.push(s);
  }

  function addSerializers(serializers) {
    if (!self.serializers) {
      self.serializers = {};
    }
    Object.keys(serializers).forEach(function (field) {
      var serializer = serializers[field];
      if (typeof(serializer) !== "function") {
        throw new TypeError(format(
          'invalid serializer for "%s" field: must be a function', field));
      } else {
        self.serializers[field] = serializer;
      }
    });
  }

  // Handle *config* options.
  if (options.stream) {
    addStream({
      type: "stream",
      stream: options.stream,
      closeOnExit: false,
      level: (options.level ? resolveLevel(options.level) : INFO)
    });
  } else if (options.streams) {
    options.streams.forEach(addStream);
  } else if (!parent) {
    addStream({
      type: "stream",
      stream: process.stdout,
      closeOnExit: false,
      level: (options.level ? resolveLevel(options.level) : INFO)
    });
  }
  if (options.serializers) {
    addSerializers(options.serializers);
  }
  xxx("Logger: ", self)
  
  // Fields.
  // These are the default fields for log records (minus the attributes
  // removed in this constructor). To allow storing raw log records
  // (unrendered), `this.fields` must never be mutated. Create a copy for
  // any changes.
  var fields = objCopy(options);
  delete fields.stream;
  delete fields.level;
  delete fields.streams;
  delete fields.serializers;
  if (this.serializers) {
    this._applySerializers(fields);
  }
  if (!fields.hostname) {
    fields.hostname = os.hostname();
  }
  Object.keys(fields).forEach(function (k) {
    self.fields[k] = fields[k];
  });
}


/**
 * Create a child logger, typically to add a few log record fields.
 *
 * This can be useful when passing a logger to a sub-component, e.g. a
 * "wuzzle" component of your service:
 *
 *    var wuzzleLog = log.child({component: "wuzzle"})
 *    var wuzzle = new Wuzzle({..., log: wuzzleLog})
 *
 * Then log records from the wuzzle code will have the same structure as
 * the app log, *plus the component="wuzzle" field*.
 *
 * @param options {Object} Optional. Set of options to apply to the child.
 *    All of the same options for a new Logger apply here. Notes:
 *      - The parent's streams are inherited and cannot be removed in this
 *        call.
 *      - The parent's serializers are inherited, though can effectively be
 *        overwritten by using duplicate keys.
 * @param simple {Boolean} Optional. Set to true to assert that `options`
 *    (a) only add fields (no config) and (b) no serialization handling is
 *    required for them. IOW, this is a fast path for frequent child
 *    creation. See "tools/timechild.js" for numbers.
 */
Logger.prototype.child = function (options, simple) {
  return new Logger(this, options || {}, simple);
}


///**
// * Close this logger.
// *
// * This closes streams (that it owns, as per "endOnClose" attributes on
// * streams), etc. Typically you **don't** need to bother calling this.
// */
//Logger.prototype.close = function () {
//  if (this._closed) {
//    return;
//  }
//  if (!this._isSimpleChild) {
//    self.streams.forEach(function (s) {
//      if (s.endOnClose) {
//        xxx("closing stream s:", s);
//        s.stream.end();
//        s.endOnClose = false;
//      }
//    });
//  }
//  this._closed = true;
//}


/**
 * Apply registered serializers to the appropriate keys in the given fields.
 *
 * Pre-condition: This is only called if there is at least one serializer.
 *
 * @param fields (Object) The log record fields.
 * @param keys (Array) Optional array of keys to which to limit processing.
 */
Logger.prototype._applySerializers = function (fields, keys) {
  var self = this;

  // Mapping of keys to potentially serialize.
  var applyKeys = fields;
  if (keys) {
    applyKeys = {};
    for (var i=0; i < keys.length; i++) {
      applyKeys[keys[i]] = true;
    }
  }
  
  xxx('_applySerializers: applyKeys', applyKeys);
  
  // Check each serializer against these (presuming number of serializers
  // is typically less than number of fields).
  Object.keys(this.serializers).forEach(function (name) {
    if (applyKeys[name]) {
      xxx('_applySerializers; apply to "%s" key', name)
      try {
        fields[name] = self.serializers[name](fields[name]);
      } catch (err) {
        process.stderr.write(format('bunyan: ERROR: This should never happen. '
          + 'This is a bug in <https://github.com/trentm/node-bunyan> or '
          + 'in this application. Exception from "%s" Logger serializer: %s',
          name, err.stack || err));
        fields[name] = format('(Error in Bunyan log "%s" serializer '
          + 'broke field. See stderr for details.)', name);
      }
    }
  });
}


/**
 * A log record is a 4-tuple:
 *    [<default fields object>,
 *     <log record fields object>,
 *     <level integer>,
 *     <msg args array>]
 * For Perf reasons, we only render this down to a single object when
 * it is emitted.
 */
Logger.prototype._mkRecord = function (fields, level, msgArgs) {
  var recFields = (fields ? objCopy(fields) : null);
  return [this.fields, recFields, level, msgArgs];
}


/**
 * Emit a log record.
 *
 * @param rec {log record}
 */
Logger.prototype._emit = function (rec) {
  var obj = objCopy(rec[0]);
  var recFields = rec[1];
  if (recFields) {
    if (this.serializers) {
      this._applySerializers(recFields);
    }
    Object.keys(recFields).forEach(function (k) {
      obj[k] = recFields[k];
    });
  }
  var level = obj.level = rec[2];
  xxx("Record:", rec)
  obj.msg = format.apply(this, rec[3]);
  if (!obj.time) {
    obj.time = (new Date());
  }
  obj.v = LOG_VERSION;
  
  xxx('_emit: stringify this:', obj);
  var str = JSON.stringify(obj) + '\n';
  this.streams.forEach(function(s) {
    if (s.level <= level) {
      xxx('writing log rec "%s" to "%s" stream (%d <= %d)', obj.msg, s.type,
        s.level, level);
      s.stream.write(str);
    }
  });
}


/**
 * Log a record at TRACE level.
 *
 * Usages:
 *    log.trace()  -> boolean is-trace-enabled
 *    log.trace(<string> msg, ...)
 *    log.trace(<object> fields, <string> msg, ...)
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.trace = function () {
  var fields = null, msgArgs = null;
  if (arguments.length === 0) {   // `log.trace()`
    return (this.level <= TRACE);
  } else if (this.level > TRACE) {
    return;
  } else if (typeof arguments[0] === 'string') {  // `log.trace(msg, ...)`
    fields = null;
    msgArgs = Array.prototype.slice.call(arguments);
  } else {  // `log.trace(fields, msg, ...)`
    fields = arguments[0];
    msgArgs = Array.prototype.slice.call(arguments, 1);
  }
  var rec = this._mkRecord(fields, TRACE, msgArgs);
  this._emit(rec);
}

/**
 * Log a record at DEBUG level.
 *
 * Usages:
 *    log.debug()  -> boolean is-debug-enabled
 *    log.debug(<string> msg, ...)
 *    log.debug(<object> fields, <string> msg, ...)
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.debug = function () {
  var fields = null, msgArgs = null;
  if (arguments.length === 0) {   // `log.debug()`
    return (this.level <= DEBUG);
  } else if (this.level > DEBUG) {
    return;
  } else if (typeof arguments[0] === 'string') {  // `log.debug(msg, ...)`
    fields = null;
    msgArgs = Array.prototype.slice.call(arguments);
  } else {  // `log.debug(fields, msg, ...)`
    fields = arguments[0];
    msgArgs = Array.prototype.slice.call(arguments, 1);
  }
  var rec = this._mkRecord(fields, DEBUG, msgArgs);
  this._emit(rec);
}

/**
 * Log a record at INFO level.
 *
 * Usages:
 *    log.info()  -> boolean is-info-enabled
 *    log.info(<string> msg, ...)
 *    log.info(<object> fields, <string> msg, ...)
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.info = function () {
  var fields = null, msgArgs = null;
  if (arguments.length === 0) {   // `log.info()`
    return (this.level <= INFO);
  } else if (this.level > INFO) {
    return;
  } else if (typeof arguments[0] === 'string') {  // `log.info(msg, ...)`
    fields = null;
    msgArgs = Array.prototype.slice.call(arguments);
  } else {  // `log.info(fields, msg, ...)`
    fields = arguments[0];
    msgArgs = Array.prototype.slice.call(arguments, 1);
  }
  var rec = this._mkRecord(fields, INFO, msgArgs);
  this._emit(rec);
}

/**
 * Log a record at WARN level.
 *
 * Usages:
 *    log.warn()  -> boolean is-warn-enabled
 *    log.warn(<string> msg, ...)
 *    log.warn(<object> fields, <string> msg, ...)
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.warn = function () {
  var fields = null, msgArgs = null;
  if (arguments.length === 0) {   // `log.warn()`
    return (this.level <= WARN);
  } else if (this.level > WARN) {
    return;
  } else if (typeof arguments[0] === 'string') {  // `log.warn(msg, ...)`
    fields = null;
    msgArgs = Array.prototype.slice.call(arguments);
  } else {  // `log.warn(fields, msg, ...)`
    fields = arguments[0];
    msgArgs = Array.prototype.slice.call(arguments, 1);
  }
  var rec = this._mkRecord(fields, WARN, msgArgs);
  this._emit(rec);
}

/**
 * Log a record at ERROR level.
 *
 * Usages:
 *    log.error()  -> boolean is-error-enabled
 *    log.error(<string> msg, ...)
 *    log.error(<object> fields, <string> msg, ...)
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.error = function () {
  var fields = null, msgArgs = null;
  if (arguments.length === 0) {   // `log.error()`
    return (this.level <= ERROR);
  } else if (this.level > ERROR) {
    return;
  } else if (typeof arguments[0] === 'string') {  // `log.error(msg, ...)`
    fields = null;
    msgArgs = Array.prototype.slice.call(arguments);
  } else {  // `log.error(fields, msg, ...)`
    fields = arguments[0];
    msgArgs = Array.prototype.slice.call(arguments, 1);
  }
  var rec = this._mkRecord(fields, ERROR, msgArgs);
  this._emit(rec);
}

/**
 * Log a record at FATAL level.
 *
 * Usages:
 *    log.fatal()  -> boolean is-fatal-enabled
 *    log.fatal(<string> msg, ...)
 *    log.fatal(<object> fields, <string> msg, ...)
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.fatal = function () {
  var fields = null, msgArgs = null;
  if (arguments.length === 0) {   // `log.fatal()`
    return (this.level <= FATAL);
  } else if (this.level > FATAL) {
    return;
  } else if (typeof arguments[0] === 'string') {  // `log.fatal(msg, ...)`
    fields = null;
    msgArgs = Array.prototype.slice.call(arguments);
  } else {  // `log.fatal(fields, msg, ...)`
    fields = arguments[0];
    msgArgs = Array.prototype.slice.call(arguments, 1);
  }
  var rec = this._mkRecord(fields, FATAL, msgArgs);
  this._emit(rec);
}



//---- Standard serializers
// A serializer is a function that serializes a JavaScript object to a
// JSON representation for logging. There is a standard set of presumed
// interesting objects in node.js-land.

Logger.stdSerializers = {};

// Serialize an HTTP request.
Logger.stdSerializers.req = function req(req) {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    remoteAddress: req.connection.remoteAddress,
    remotePort: req.connection.remotePort
  };
  // Trailers: Skipping for speed. If you need trailers in your app, then
  // make a custom serializers.
  //if (Object.keys(trailers).length > 0) {
  //  obj.trailers = req.trailers;
  //}
};

// Serialize an HTTP response.
Logger.stdSerializers.res = function res(res) {
  return {
    statusCode: res.statusCode,
    header: res._header
  }
};

// Serialize an Error object
// (Core error properties are enumerable in node 0.4, not in 0.6).
Logger.stdSerializers.err = function err(err) {
  var obj = {
    message: err.message,
    name: err.name,
    stack: err.stack
  }
  Object.keys(err).forEach(function (k) {
    if (err[k] !== undefined) {
      obj[k] = err[k];
    }
  });
  return obj;
};



//---- Exports

module.exports = Logger;
module.exports.VERSION = VERSION;
module.exports.LOG_VERSION = LOG_VERSION;

