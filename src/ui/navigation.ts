const destinations = ['stock', 'supply', 'issues', 'masters', 'management'] as const;
export type Destination = (typeof destinations)[number];
export type NavigationTarget =
  | { kind: 'destination'; destination: Destination }
  | { kind: 'detail' }
  | { kind: 'about' };

export interface Navigation {
  readonly current: Destination;
  select(target: NavigationTarget): void;
  setIssueCount(count: number): void;
  setReadable(readable: boolean): void;
}

export function navigationOf(root: HTMLElement): Navigation {
  function required(id: string): HTMLElement {
    const matches = root.querySelectorAll(`#${id}`);
    const node = matches[0];
    if (matches.length !== 1 || !(node instanceof HTMLElement)) throw new Error(`画面の必須要素が一意でない: ${id}`);
    return node;
  }
  const pages = destinations.map(destination => {
    const button = required(`nav-${destination}`);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`行き先の操作がボタンでない: ${destination}`);
    return { destination, button, body: required(`page-${destination}`) };
  });
  required('destinations');
  const input = required('input');
  const countLabel = required('issue-count');
  const unavailable = required('unreadable-content');
  const detailHeading = required('detail-h');
  const aboutHeading = required('about-h');
  const aboutLink = required('about-link');
  let current: Destination = 'stock';
  let readable = true;
  let issueCount = 0;

  function showCount(): void {
    const text = readable ? `${issueCount}件` : '件数を確認できない';
    if (countLabel.textContent !== text) countLabel.textContent = text;
  }
  function show(): void {
    for (const { destination, button, body } of pages) {
      body.hidden = destination !== current || (!readable && destination !== 'management');
      if (destination === current) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    input.hidden = current === 'management';
    unavailable.hidden = readable || current === 'management';
    showCount();
  }
  function select(target: NavigationTarget): void {
    switch (target.kind) {
      case 'destination': current = target.destination; break;
      case 'detail': current = 'stock'; break;
      case 'about': current = 'management'; break;
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
    show();
    if (target.kind === 'detail' && readable) detailHeading.focus();
    if (target.kind === 'about') aboutHeading.focus();
  }
  for (const { destination, button } of pages) button.addEventListener('click', () => select({ kind: 'destination', destination }));
  aboutLink.addEventListener('click', () => select({ kind: 'about' }));
  show();
  return {
    get current() { return current; },
    select,
    setIssueCount(count) {
      if (!Number.isInteger(count) || count < 0) throw new RangeError('確認が必要件数は0以上の整数が必要です');
      issueCount = count;
      showCount();
    },
    setReadable(value) { readable = value; show(); },
  };
}
