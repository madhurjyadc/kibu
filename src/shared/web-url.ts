/** External result links may open web pages, never OS protocol handlers. */
export function externalWebUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A web address is required.')
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP and HTTPS links can be opened.')
  return url.href
}
