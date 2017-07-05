const bluebird = require("bluebird");
const child_process = require('child_process');
const fs = require("fs");
const path = require("path");

const Promise = bluebird.Promise;
const readFile = bluebird.promisify(fs.readFile);
const realpath = bluebird.promisify(fs.realpath);
const stat = bluebird.promisify(fs.stat);
const writeFile = bluebird.promisify(fs.writeFile);

const PACKAGE_JSON = "package.json";
const PYTHON_MODULES = "python_modules";

const OPTION_RE = /^-/;
const ARGUMENT_OPTION_RE = /^-[QWX]$/;
const TERMINATE_RE = /^-[cm]?$/;


const findSourceArg = (args) => {
  for (let i = 0; i < args.length; ++i) {
    let arg = args[i];

    // Check for an option that signals there will be no python source path.
    if (TERMINATE_RE.test(arg))
      break;

    // Skip option and its argument.
    if (ARGUMENT_OPTION_RE.test(arg)) {
      ++i;
      continue;
    }

    // Skip other options.
    if (OPTION_RE.test(arg))
      continue;

    return i;
  }

  return -1;
}

const getPythonScriptsDir = (packageDir, env = process.env) => {
  let cachePath = path.join(packageDir, PYTHON_MODULES, ".scripts");
  return readFile(cachePath, "utf-8")
  .then(relativePath => path.join(packageDir, relativePath))
  .catch(error => {
    if (error.code !== "ENOENT")
      throw error;
    let child = child_process.spawn("python3", ["-m", "site", "--user-site"], { env });
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", data => {
        stdout += data;
      });
      child.stderr.on("data", data => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", code => {
        if (code !== 0)
          reject(new Error(`Python site module exited with code ${code}.\n${stderr}`));
        resolve(stdout);
      })
    }).then(stdout => {
      let siteDir = (/^(.*)$/m).exec(stdout)[1];
      let scriptsDir = path.normalize(path.join(siteDir, "..", "Scripts"));
      let relativePath = path.relative(packageDir, scriptsDir);

      return writeFile(cachePath, relativePath, "utf-8")
      .then(() => scriptsDir)
      .catch(() => scriptsDir)
    });
  });
}

const joinPaths = (...paths) => {
  let sep = ":";
  if (process.platform === "win32")
    sep = ";";
  return paths.filter(p => p).join(sep);
}

// Environment variables are case insensitive on Windows.
const fixEnv = (env) => {
  if (process.platform !== "win32")
    return env;

  let upperEnv = {};
  for (let key in env) {
    if (Object.prototype.hasOwnProperty.call(env, key))
      upperEnv[key.toUpperCase()] = env[key];
  }

  return upperEnv;
}

class Package {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  readJSON() {
    let result = readFile(path.join(this.dir, PACKAGE_JSON)).then(text => {
      let json = JSON.parse(text);
      json = Object.assign({
        python: {},
      }, json);
      json.python.dependencies = Object.assign({}, json.python.dependencies);
      json.python.devDependencies = Object.assign({}, json.python.devDependencies);
      json.python.path = json.python.path || ".";
      if (!Array.isArray(json.python.path))
        json.python.path = [json.python.path];
      return json;
    });
    this.readJSON = () => result;
    return result;
  }

  pythonEnv(env) {
    env = Object.assign({}, env || process.env);

    delete env.PYTHONNOUSERSITE;
    env.PYTHONUSERBASE = path.join(this.dir, PYTHON_MODULES);

    let upperEnv = fixEnv(env);

    return this.readJSON().then(json => {
      let pythonPath = json.python.path;
      pythonPath = pythonPath.map(p => path.resolve(this.dir, p));
      env.PYTHONPATH = joinPaths(...pythonPath);

      return getPythonScriptsDir(this.dir, env)
      .then(scriptsDir => {
        env.PATH = joinPaths(scriptsDir, upperEnv.PATH || "");
        return env;
      });
    });
  }
}

const findPackage = (descendent) => {
  if (descendent)
    descendent = path.resolve(descendent);
  else
    descendent = process.cwd();

  let ancestor = descendent;
  let ancestors = [];
  for (;;) {
    ancestors.push(ancestor);
    let p = path.dirname(ancestor);
    if (!p || p == ancestor)
      break;
    ancestor = p;
  }

  return Promise.map(ancestors, (ancestor) => {
    return stat(path.join(ancestor, PACKAGE_JSON))
      .then(obj => obj.isFile() && ancestor)
      .catch(() => false)
  })
  .then(packages => {
    packages = packages.filter(pkg => pkg);
    if (packages.length === 0)
      throw new Error("Could not find directory containing package.json");
    return new Package(packages[0]);
  });
}

const spawnPython = (args, options = {}) => {
  args = args.slice(0);
  options = Object.assign({
    interop: "status",
    package: undefined,
    execPath: "python3",
    spawn: {},
    throwNonZeroStatus: true,
  }, options);

  let pkg;
  if (options.package) {
    pkg = Promise.resolve(options.package);
  } else {
    let sourcePathIdx = findSourceArg(args);
    let sourcePath;
    if (sourcePathIdx >= 0)
      sourcePath = args[sourcePathIdx];

    if (sourcePath)
      pkg = realpath(sourcePath).then(findPackage);
    else
      pkg = findPackage(process.cwd());
  }

  return pkg
  .then(pkg => pkg.pythonEnv(options.spawn.env))
  .then(env => {
    options.spawn.env = env;
    let child = child_process.spawn(options.execPath, args, options.spawn);
    switch (options.interop) {
    case "child":
      return child;
    case "buffer":
      return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", data => {
          stdout += data;
        });
        child.stderr.on("data", data => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", code => {
          if (options.throwNonZeroStatus && code !== 0)
            reject(new Error(`Exited with code ${code}.\n${stderr}`));
          resolve({ code, stdout, stderr });
        });
      });
    case "status":
      return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => {
          if (options.throwNonZeroStatus && code !== 0)
            reject(new Error(`Exited with code ${code}.`));
          resolve(code);
        });
      });
    default:
      throw new Error(`Unexpected interop mode ${options.interop}`);
    }
  });
}

module.exports = {
  Package,
  findPackage,
  findSourceArg,
  spawnPython,
}
