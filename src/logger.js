/**
 * node-console-utils - Logger
 *
 * Copyright (C) 2021 Doug Owings
 * 
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 * 
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
const {Instance: Chalk, level: DefaultColor} = require('chalk')
const chalkPipe = require('chalk-pipe')
const {formatWithOptions} = require('util')
const HashProxy = require('./hash-proxy.js')
const {Cast, Is} = require('./util/types.js')
const {Caret} = require('./util/chars.js')
const {cat} = require('./util/strings.js')
const {merge} = require('./util/merge.js')
const {parseStack} = require('./util/errors.js')
const {revalue} = require('./util/objects.js')

const {ArgumentError} = require('./errors.js')

const LevelNums = {
    error : 0,
    warn  : 1,
    info  : 2,
    log   : 3,
    debug : 4,
}

const LevelNames = Object.keys(LevelNums).sort((a, b) =>
    LevelNums[a] - LevelNums[b]
)

const Defaults = {}

Defaults.stdout = process.stdout
Defaults.stderr = process.stderr

/**
 * The default log level. If the `DEBUG` environment variable is set, then the
 * default is debug (4). Then the environment variables `LOG_LEVEL` and `LOGLEVEL`
 * are checked. Otherwise the default is info (2).
 */
if (process.env.DEBUG) {
    Defaults.logLevel = 'debug'
} else if (process.env.LOG_LEVEL) {
    Defaults.logLevel = process.env.LOG_LEVEL
} else if (process.env.LOGLEVEL) {
    Defaults.logLevel = process.env.LOGLEVEL
} else {
    Defaults.logLevel = 'info'
}
Defaults.logLevel = getLevelNumber(Defaults.logLevel)

/**
 * Whether to use colors. Default is to use chalk's determination.
 *
 * {integer}
 */
Defaults.colors = DefaultColor

/**
 * The chalk color styles to use.
 */
Defaults.styles = {
    default: 'chalk',
    brace: 'grey',
    error: {
        prefix  : 'red',
        string  : '#884444',
        file    : 'yellow',
        name    : 'bgRedBright.bold.black',
        message : '#884444',
        stack   : 'grey',
    },
    warn: {
        prefix : 'yellow',
        string : 'chalk',
        file   : 'yellow',
    },
    info: {
        prefix : 'grey',
        string : 'chalk',
        file   : 'cyan',
    },
    log: {
        prefix : 'grey',
        string : 'chalk',
        file   : 'cyan',
    },
    debug: {
        prefix : 'blue',
        string : 'chalk',
    },
}

/**
 * Log prefix function.
 *
 * @param {string} The log level, error, warn, info, log, or debug.
 * @return {string|array} The formatted prefix message(s)
 */
Defaults.prefix = function (level) {
    const {chalks} = this
    if (level === 'info') {
        return chalks[level].prefix(Caret)
    }
    return cat(
        chalks.brace('['),
        chalks[level].prefix(level.toUpperCase()),
        chalks.brace(']'),
    )
}

/**
 * Pre-process/filter arguments before they are formatted and logged.
 * This is only for calls to log methods, and not general formatting
 * methods.
 *
 * @param {string} The log level, error, warn, info, log, or debug.
 * @param {array} The arguments of any type.
 * @return {string|array} The processed/filtered arguments of any type.
 */
Defaults.prelog = function (level, args) {
    const chlk = this.chalks[level]
    let hasError = false
    return args.map(arg => {
        if (Is.String(arg)) {
            return chlk.string(arg)
        }
        if (Is.Error(arg)) {
            hasError = true
            return this.formatError(arg, args.some(arg => arg && arg.throwing))
        }
        if (Is.PlainObject(arg)) {
            // Handle special keys.
            const entries = Object.entries(arg)
            if (entries.length == 1) {
                const [key, value] = entries[0]
                if (key === 'throwing' && hasError) {
                    return null
                }
                if (key in chlk && Is.String(value)) {
                    return chlk.string(`${key}: ` + chlk[key](value))
                }
            }
        }
        return arg
    }).filter(arg => arg != null)
}

/**
 * Format arguments to a string. This is called for prefixing, logging,
 * and the general format() method.
 *
 * @param {array} The arguments of any type.
 * @return {string} The formatted message string.
 */
Defaults.format = function (args) {
    const {colors} = this.opts
    return formatWithOptions({colors}, ...args)
}

/**
 * The main logging function, bound to individual methods in the constructor.
 *
 * @param {string} The level, 'info', 'warn', etc.
 * @param {...*} The arguments
 * @return {undefined}
 */
function log(level, ...args) {
    level = getLevelNumber(level)
    if (level > this.logLevel) {
        return
    }
    const method = level < 2 ? 'ewrite' : 'write'
    const levelName = LevelNames[level]
    const {opts} = this
    if (Is.Function(opts.prelog)) {
        const result = opts.prelog.call(this, levelName, args)
        // If the prelog function did not return anything, then we assume
        // that it modified in place. Otherwise we take the return value,
        // where null is cast to empty string.
        if (result !== undefined) {
            args = Cast.toArray(result)
        }
    }
    const prefixes = Cast.toArray(getOrCall(opts.prefix, this, levelName))
    const prefix = prefixes.length ? this.format(...prefixes) : null
    const body = args.length ? this.format(...args) : ''
    if (prefix) {
        this[method](prefix + (body ? ' ' : ''))
    }
    this[method](body + '\n')
}

module.exports = class Logger {

    constructor(opts) {
        opts = merge(Defaults, opts)
        checkWriteStream(opts.stdout, 'opts.stdout')
        checkWriteStream(opts.stderr, 'opts.stderr')
        const chalk = new Chalk({
            level: opts.colors ? Defaults.colors : 0
        })
        const chalkp = HashProxy(opts.styles, {
            filter     : Is.String,
            transform  : style => chalkPipe(style, chalk),
            enumerable : true,
        })
        Object.defineProperties(opts, {
            colors: {
                enumerable: true,
                get: () => Boolean(this.chalk.level),
                set: n => this.chalk.level = n ? Defaults.colors : 0,
            },
            styles: {get: () => chalkp.ingress, enumerable: true},
        })
        Object.defineProperties(this, {
            chalk  : {value: chalk},
            chalks : {value: chalkp.target},
            opts   : {value: opts},
            ...revalue(LevelNums, level => (
                {value: log.bind(this, level), enumerable: true}
            )),
        })
    }

    write(data) {
        this.stdout.write(data)
    }

    ewrite(data) {
        this.stderr.write(data)
    }

    print(...args) {
        this.write(this.format(...args) + '\n')
    }

    eprint(...args) {
        this.ewrite(this.format(...args) + '\n')
    }

    format(...args) {
        return this.opts.format.call(this, args)
    }

    get stdout() {
        return this.opts.stdout
    }

    set stdout(stdout) {
        this.opts.stdout = stdout
    }

    get stderr() {
        return this.opts.stderr
    }

    set stderr(stderr) {
        this.opts.stderr = stderr
    }

    get logLevel() {
        return getLevelNumber(this.opts.logLevel)
    }

    set logLevel(n) {
        this.opts.logLevel = n
    }

    formatError(err, isSkipStack = false) {
        const chlk = this.chalks.error
        const {stack, rawMessage} = parseStack(err)
        const name = err.name || err.constructor.name
        const lines = []
        lines.push(
            [chlk.name(name), chlk.message(rawMessage)].join(': ')
        )
        if (!isSkipStack) {
            lines.push(chlk.stack(stack))
        }
        return lines.join('\n')
    }
}

function getLevelNumber(value) {
    if (Is.String(value)) {
        value = value.toLowerCase()
    }
    if (value in LevelNums) {
        return LevelNums[value]
    }
    if (value in LevelNames) {
        return +value
    }
    if (value < 0) {
        return -1
    }
    return Defaults.logLevel
}

function checkWriteStream(arg, name) {
    if (!Is.WriteableStream(arg)) {
        throw new ArgumentError(`Argument ${name} is not a writeable stream`)
    }
}

function getOrCall(thing, ...args) {
    return Is.Function(thing) ? thing.call(...args) : thing
}