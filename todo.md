# Todo

## Features

* Unittests
* bare !quote to respond any userQuote, similar to /quote
* Check if permissions are sufficient on start to avoid runtime exceptions

## Bugs

* Wink response does not work since emojis are not considered a word boundary

## Infra

* Improve monitoring, Prometheus metrics
* Proper secret management, temporary storage (redis, vault...?)
