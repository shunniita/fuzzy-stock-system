export function slug(text: string): string;
export function anchorOf(chapter: string, id: string): string;
export function inline(text: string, chapter: string): string;
export function toHtml(markdown: string, chapter: string): string;
export function bookHtml(chapters: { name: string; markdown: string }[], version: string): string;
