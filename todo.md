# Features

* Handling opt-in roles
* Unittests
* bare !quote to respond any userQuote, similar to /quote
* Exponential back-off for staging->production check

# Bugs

* Wink response does not work since emojis are not considered a word boundary

# Infra

* Improve monitoring, Prometheus metrics
* Proper secret management, temporary storage (redis, vault...?)
