export const eightBallResponses = [
  ":8ball: Ziemlich sicher.",
  ":8ball: Es ist entschieden.",
  ":8ball: Ohne Zweifel.",
  ":8ball: Ja, absolut.",
  ":8ball: Du kannst darauf zählen.",
  ":8ball: Sehr wahrscheinlich.",
  ":8ball: Sieht gut aus.",
  ":8ball: Ja.",
  ":8ball: Die Zeichen stehen auf Ja.",
  ":8ball: Antwort unklar.",
  ":8ball: Frag mich später noch mal.",
  ":8ball: Sag ich dir besser noch nicht.",
  ":8ball: Kann ich noch nicht sagen.",
  ":8ball: Konzentriere dich und frage erneut.",
  ":8ball: Zähl nicht darauf.",
  ":8ball: Meine Antwort ist nein.",
  ":8ball: Meine Quellen sagen nein.",
  ":8ball: Sieht nicht so gut aus.",
  ":8ball: Sehr unwahrscheinlich.",
];

export function getRandomEightBallResponse(randomFn: () => number = Math.random): string {
  return eightBallResponses[Math.floor(randomFn() * eightBallResponses.length)] ?? "Antwort unklar.";
}
