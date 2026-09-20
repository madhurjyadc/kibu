/** Local vocabulary shared by routing and retrieval. No document text leaves the Mac. */
const DOCUMENTS = [
  { pattern: /\b(?:e[ -]?)?(?:aadhaar|aadhar|adhar|adhaar|aadhhar|uidai)\b|आधार/iu, terms: ['aadhaar', 'aadhar', 'adhar', 'adhaar', 'uidai', 'आधार'] },
  { pattern: /\bpan\s*(?:card|document)\b/iu, terms: ['pan', 'permanent account number'] },
  { pattern: /\bpassport\b/iu, terms: ['passport'] },
  { pattern: /\b(?:driv(?:ing|er'?s?)\s+licen[cs]e)\b/iu, terms: ['driving licence', 'driving license', 'drivers license'] },
  { pattern: /\b(?:cv|resum[eé])\b/iu, terms: ['resume', 'résumé', 'cv'] },
  { pattern: /\b(?:insurance|insurence)\b/iu, terms: ['insurance', 'insurence'] }
]

export function documentTerms(text: string): string[] {
  return [...new Set(DOCUMENTS.filter((d) => d.pattern.test(text)).flatMap((d) => d.terms))]
}

export function hasLocalSearchIntent(text: string): boolean {
  const request = /\b(find|locate|search|look for|where(?:'s| is| are)|show|open)\b/i.test(text)
  return request && (documentTerms(text).length > 0 || /\b(?:my|this)\s+(?:pc|computer|mac|laptop|device)\b/i.test(text))
}

export function removeDocumentWords(text: string): string {
  let cleaned = text
  for (const document of DOCUMENTS) {
    if (document.pattern.test(text)) cleaned = cleaned.replace(document.pattern, ' ')
  }
  return cleaned
}
