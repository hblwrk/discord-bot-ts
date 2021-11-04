# Features

* Futures ticker, realtime data without page scraping from webull mqtt, yahoo-finance, investing...?
* Handling opt-in roles
* /whatis_something as /whatis \<something\> slashcommand?
* Asset-cache to avoid frequent storage access, potentially pre-populate

# Bugs

* Wink response does not work since emojis are not considered a word boundary
* Proper escaping for user generated input

# Infra

* Improve monitoring, Prometheus metrics
* CI step to check if the app runs fine before allowing to merge (basic functional testing)
