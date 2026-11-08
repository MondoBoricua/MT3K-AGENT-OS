import type { MosaicLayout } from "../lib/mosaic-layout";

type Props = { layout: MosaicLayout; onChange: (layout: MosaicLayout) => void };

const OPTIONS: { value: MosaicLayout; title: string }[] = [
  { value: "1x1", title: "Una sesión a pantalla completa (teclas 1-4 cambian de slot)" },
  { value: "2x2", title: "Cuadrícula de 4 sesiones" },
];

export default function MosaicLayoutSwitch({ layout, onChange }: Props) {
  return (
    <div role="group" aria-label="Disposición del mosaico" className="flex overflow-hidden rounded-lg border border-ink-line">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={layout === o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 font-mono text-xs transition ${
            layout === o.value ? "bg-accent/20 text-accent" : "bg-ink-850/60 text-white/60 hover:text-white"
          }`}
        >
          {o.value}
        </button>
      ))}
    </div>
  );
}
