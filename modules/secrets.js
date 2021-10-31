const fs = require('fs');

const secrets = {};

secrets.read = function read(secretName) {
  try {
    // Attempting to fetch Docker secret
    return fs.readFileSync(`/run/secrets/${secretName}`, 'utf8');
  } catch(err) {
    // Fall back to config.json in case Docker secret is unavailable
    const keys = JSON.parse(fs.readFileSync('config.json', 'utf8'))
    return getValueFromJSONConfig(keys, secretName);
  }
};

function getValueFromJSONConfig(config, key) {
  var string = JSON.stringify(config);
  var objectValue = JSON.parse(string);
  return objectValue[key];
}

module.exports = secrets;
