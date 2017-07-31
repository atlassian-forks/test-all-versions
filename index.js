#!/usr/bin/env node
'use strict'

var exec = require('child_process').exec
var execSync = require('child_process').execSync
var fs = require('fs')
var isCI = require('is-ci')
var yaml = require('js-yaml')
var once = require('once')
var pkgVersions = require('npm-package-versions')
var semver = require('semver')
var afterAll = require('after-all-results')
var resolve = require('resolve')
var fresh = require('fresh-require')
var install = require('spawn-npm-install')
var argv = require('minimist')(process.argv.slice(2))

// execSync was added in Node.js v0.11.12, so if it doesn't exist, we'll just
// assume that npm5 isn't used either
var npm5plus = execSync && semver.gte(execSync('npm -v', {encoding: 'utf-8'}).trim(), '5.0.0')

process.env.PATH = 'node_modules' + require('path').sep + '.bin:' + process.env.PATH

var tests = []

if (argv.help || argv.h) {
  console.log('Usage: tav [options] [<module> <semver> <command> [args...]]')
  console.log()
  console.log('Options:')
  console.log('  -h, --help   show this help')
  console.log('  -q, --quiet  don\'t output stdout from tests unless an error occors')
  console.log('  --ci         only run on CI servers when using .tav.yml file')
  process.exit()
}

if (argv._.length === 0) {
  loadYaml()
} else {
  tests.push({
    name: argv._.shift(),    // module name
    semver: argv._.shift(),  // module semver
    cmds: [argv._.join(' ')] // test command
  })
}

runTests()

function loadYaml () {
  var conf = yaml.safeLoad(fs.readFileSync('.tav.yml').toString())
  var whitelist = process.env.TAV ? process.env.TAV.split(',') : null

  Object.keys(conf)
    .filter(function (name) {
      // In case the key isn't the name of the package, but instead a package
      // name have been set manually using the name property
      name = conf[name].name || name

      // Only run selected test if TAV environment variable is used
      return whitelist ? whitelist.indexOf(name) !== -1 : true
    })
    .map(function (name) {
      var m = conf[name]

      // In case the key isn't the name of the package, but instead a package
      // name have been set manually using the name property
      name = conf[name].name || name

      if (m.node && !semver.satisfies(process.version, m.node)) return

      var cmds = Array.isArray(m.commands) ? m.commands : [m.commands]

      if (m.peerDependencies) {
        var peerDependencies = Array.isArray(m.peerDependencies) ? m.peerDependencies : [m.peerDependencies]
      }

      if (!m.versions) throw new Error('Missing "versions" property for ' + name)

      tests.push({
        name: name,
        semver: m.versions,
        cmds: cmds,
        peerDependencies: peerDependencies,
        pretest: m.pretest,
        posttest: m.posttest
      })
    })
}

function runTests (err) {
  if (argv.ci && !isCI) return
  if (err || tests.length === 0) return done(err)
  test(tests.pop(), runTests)
}

function test (opts, cb) {
  pkgVersions(opts.name, function (err, versions) {
    if (err) return cb(err)

    versions = versions.filter(function (version) {
      return semver.satisfies(version, opts.semver)
    })

    run()

    function run (err) {
      if (err || versions.length === 0) return cb(err)
      testVersion(opts, versions.pop(), run)
    }
  })
}

function testVersion (test, version, cb) {
  var i = 0

  run()

  function run (err) {
    if (err || i === test.cmds.length) return cb(err)

    var packages = [].concat(test.peerDependencies || [], test.name + '@' + version)

    ensurePackages(packages, function (err) {
      if (err) return cb(err)

      pretest(function (err) {
        if (err) return cb(err)

        testCmd(test.name, version, test.cmds[i++], function (code) {
          if (code !== 0) {
            var err = new Error('Test exited with code ' + code)
            err.exitCode = code
            cb(err)
          }
          posttest(run)
        })
      })
    })
  }

  function pretest (cb) {
    if (!test.pretest) return process.nextTick(cb)
    console.log('-- running pretest "%s" for %s', test.pretest, test.name)
    execute(test.pretest, test.name, cb)
  }

  function posttest (cb) {
    if (!test.posttest) return process.nextTick(cb)
    console.log('-- running posttest "%s" for %s', test.posttest, test.name)
    execute(test.posttest, test.name, cb)
  }
}

function testCmd (name, version, cmd, cb) {
  console.log('-- running test "%s" with %s', cmd, name)
  execute(cmd, name + '@' + version, cb)
}

function execute (cmd, name, cb) {
  var cp = exec(cmd)
  cp.on('close', function (code) {
    if (code !== 0 && stdout) {
      console.log('-- detected failing command, flushing stdout...')
      console.log(stdout)
    }
    cb(code)
  })
  cp.on('error', function (err) {
    console.error('-- error running "%s" with %s', cmd, name)
    console.error(err.stack)
    cb(err.code || 1)
  })
  if (!argv.quiet && !argv.q) {
    cp.stdout.pipe(process.stdout)
  } else {
    // store output in case we needed if an error occurs
    var stdout = ''
    cp.stdout.on('data', function (chunk) {
      stdout += chunk
    })
  }
  cp.stderr.pipe(process.stderr)
}

function ensurePackages (packages, cb) {
  if (npm5plus) {
    // npm5 will uninstall everything that's not in the local package.json and
    // not in the install string. This might make tests fail. So if we detect
    // npm5, we just force install everything all the time.
    attemptInstall(packages, cb)
    return
  }

  var next = afterAll(function (_, packages) {
    packages = packages.filter(function (pkg) { return !!pkg })
    if (packages.length > 0) attemptInstall(packages, cb)
    else cb()
  })

  packages.forEach(function (dependency) {
    var done = next()
    var parts = dependency.split('@')
    var name = parts[0]
    var version = parts[1]

    resolve(name + '/package.json', {basedir: process.cwd()}, function (err, pkg) {
      var installedVersion = err ? null : fresh(pkg, require).version

      if (installedVersion && semver.satisfies(installedVersion, version)) {
        console.log('-- reusing already installed %s', dependency)
        done()
        return
      }

      done(null, dependency)
    })
  })
}

function attemptInstall (packages, attempts, cb) {
  if (typeof attempts === 'function') return attemptInstall(packages, 1, attempts)

  console.log('-- installing %j', packages)

  var done = once(function (err) {
    if (!err) return cb()

    if (++attempts <= 10) {
      console.warn('-- error installing %j (%s) - retrying (%d/10)...', packages, err.message, attempts)
      attemptInstall(packages, attempts, cb)
    } else {
      console.error('-- error installing %j - aborting!', packages)
      console.error(err.stack)
      cb(err.code || 1)
    }
  })

  install(packages, {noSave: true}, done).on('error', done)
}

function done (err) {
  if (err) {
    console.log('-- fatal: ' + err.message)
    process.exit(err.exitCode || 1)
  }
  console.log('-- ok')
}
