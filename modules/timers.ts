import Schedule from "node-schedule";
import isHoliday from "nyse-holidays";

export function startTimers() {
  const ruleNYSEPremarketOpen = new Schedule.RecurrenceRule();
  ruleNYSEPremarketOpen.hour = 4;
  ruleNYSEPremarketOpen.minute = 0;
  ruleNYSEPremarketOpen.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEPremarketOpen.tz = "US/Eastern";

  const ruleNYSEOpen = new Schedule.RecurrenceRule();
  ruleNYSEOpen.hour = 9;
  ruleNYSEOpen.minute = 30;
  ruleNYSEOpen.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEOpen.tz = "US/Eastern";

  const ruleNYSEClose = new Schedule.RecurrenceRule();
  ruleNYSEClose.hour = 16;
  ruleNYSEClose.minute = 0;
  ruleNYSEOpen.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEClose.tz = "US/Eastern";

  const ruleNYSEAftermarketClose = new Schedule.RecurrenceRule();
  ruleNYSEAftermarketClose.hour = 20;
  ruleNYSEAftermarketClose.minute = 0;
  ruleNYSEAftermarketClose.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEAftermarketClose.tz = "US/Eastern";

  const jobNYSEPremarketOpen = Schedule.scheduleJob(ruleNYSEPremarketOpen, () => {
    if (false === isHoliday(new Date())) {
      console.log("NYSE Premarket Open");
    } else {
      console.log("NYSE holiday");
    }
  });

  const jobNYSEOpen = Schedule.scheduleJob(ruleNYSEOpen, () => {
    if (false === isHoliday(new Date())) {
      console.log("NYSE Open");
    } else {
      console.log("NYSE holiday");
    }
  });

  const jobNYSEClose = Schedule.scheduleJob(ruleNYSEClose, () => {
    if (false === isHoliday(new Date())) {
      console.log("NYSE Close");
    }
  });

  const jobNYSEAftermarketClose = Schedule.scheduleJob(ruleNYSEAftermarketClose, () => {
    if (false === isHoliday(new Date())) {
      console.log("NYSE Aftermarket Close");
    } else {
      console.log("NYSE holiday");
    }
  });
}
