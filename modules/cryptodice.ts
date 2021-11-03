export function roll() {
  const dice = Math.floor(Math.random() * ((100 - 1) + 1));
  return dice;
}
