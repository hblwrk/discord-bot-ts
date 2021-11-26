export function lmgtfy(search: string) {
  const link = `<http://letmegooglethat.com/?q=${encodeURIComponent(search)}>`;
  return link;
}

export function google(search: string) {
  const link = `<https://www.google.com/search?q=${encodeURIComponent(search)}>`;
  return link;
}
