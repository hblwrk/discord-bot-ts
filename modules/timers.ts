import Schedule from "node-schedule";
import {isHoliday} from "nyse-holidays";

export function startTimers() {
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
}
