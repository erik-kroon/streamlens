export default function Header() {
  return (
    <header class="border-b border-neutral-800 bg-neutral-950 px-4 py-2">
      <div class="flex items-center justify-between gap-3">
        <span class="font-mono text-xs uppercase text-neutral-500">Wiretap</span>
        <span class="text-xs text-neutral-500">SolidJS inspector</span>
      </div>
    </header>
  );
}
