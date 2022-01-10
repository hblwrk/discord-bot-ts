# Todo

## Features

* Unittests
* bare !quote to respond any userQuote, similar to /quote
* Check if permissions are sufficient on start to avoid runtime exceptions
* Logging to discord channel
* Yolo-ETF Kurs (wikifolio), 30Y bonds futures kurs
* Reflinks
* Öffnungszeiten vorab posten / abfragen
* Random betrug image, generic "random" function?
* "prune" inactive members after 12 months, timer, <https://discord.js.org/#/docs/main/stable/typedef/GuildPruneMembersOptions>
* "Market closed" Indikator wenn ein paar Minuten keine Kurse kamen
* pls boobs...
* Snapchat für arme Kanal
* /delta <symbol> <dte> befehl einbauen, der einem dann sagt, welche zwei prices über/unter dem delta liegen
* Earningswhispers screenshot
* whatis: wealthyoption, yolo etf...
* Screenshots von https://www.forexfactory.com/calendar, https://alpha.earningswhispers.com/calweek - https://openbase.com/js/screenshot-stream

## Bugs

* MNC is posted on market holiday
* Wink response does not work since emojis are not considered a word boundary

## Infra

* Improve monitoring, Prometheus metrics
* Proper secret management (vault...)?
* Temporary storage for mutes, tempbans etc. (redis...?)
