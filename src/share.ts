/**
 * Share the current view: the native share sheet where there is one (phones),
 * otherwise copy the link.
 */
export function createShare(button: HTMLButtonElement, current: () => { url: string; title: string }) {
  const toast = button.querySelector<HTMLElement>('.toast')!;
  let timer = 0;

  const say = (text: string) => {
    toast.textContent = text;
    button.classList.add('said');
    clearTimeout(timer);
    timer = window.setTimeout(() => button.classList.remove('said'), 1800);
  };

  button.addEventListener('click', async () => {
    const { url, title } = current();
    const touch = matchMedia('(hover: none)').matches;
    if (touch && navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // dismissed
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      say('Link copied');
    } catch {
      say('Copy the address bar');
    }
  });
}
