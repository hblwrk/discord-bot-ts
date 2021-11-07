# Features

* Futures ticker, realtime data without page scraping from webull mqtt, tradingeconomics ws, yahoo-finance, investing...?
  * Undocumented rate-limits make channel/category titles a bad place for frequent updates
  * Potentially spawn one bot per ticker and update their status to bypass limits...
* Handling opt-in roles
* Unittests
* bare !quote to respond any userQuote, similar to /quote
* Exponential back-off for staging->production check

# Bugs

* Wink response does not work since emojis are not considered a word boundary

# Infra

* Improve monitoring, Prometheus metrics
* Proper secret management, temporary storage (redis, vault...?)
