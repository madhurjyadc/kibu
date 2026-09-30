// Every star button keeps its own wording. Once the repository has stars, each
// one shows the live count beside it. If GitHub is offline or rate-limited, the
// buttons stay as plain links, with no invented number.
const badges = document.querySelectorAll('[data-github-stars]');
async function updateStars() {
  try {
    const response = await fetch('https://api.github.com/repos/madhurjyadc/kibu', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return;
    const { stargazers_count: count } = await response.json();
    // A count of zero says nothing useful, so the plain link stays until there is one.
    if (!Number.isSafeInteger(count) || count < 1) return;
    const formatted = new Intl.NumberFormat('en').format(count);
    for (const badge of badges) {
      const value = badge.querySelector('[data-star-count]');
      if (value) { value.textContent = formatted; value.hidden = false; }
      badge.setAttribute('aria-label', `Star Kibu on GitHub. ${formatted} ${count === 1 ? 'star' : 'stars'} so far`);
    }
  } catch {
    // The plain links are the fallback.
  }
}
if (badges.length) updateStars();
