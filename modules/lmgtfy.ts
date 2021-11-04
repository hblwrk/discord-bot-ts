export function lmgtfy(search: string) {
  const link = `<http://letmegooglethat.com/?q=${encodeURIComponent(search)}>`;
  return link;
}
