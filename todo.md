# Features

* Futures ticker, realtime data without page scraping from webull mqtt, tradingeconomics ws, yahoo-finance, investing...?
  * Undocumented rate-limits make channel/category titles a bad place for frequent updates
  * Potentially spawn one bot per ticker and update their status to bypass limits...
* Handling opt-in roles
* Asset-cache to avoid frequent storage access, potentially pre-populate
* Unittests

# Bugs

* Wink response does not work since emojis are not considered a word boundary
* Proper escaping for user generated input

# Infra

* Improve monitoring, Prometheus metrics
* CI step to check if the app runs fine before allowing to merge (basic functional testing)
* Proper secret management, temporary storage (redis, vault...?)
