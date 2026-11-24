import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { LoaderCircle, X } from "lucide-react";
export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button ${variant} ${className}`}
    />
  );
}
export function Modal({
  title,
  closeLabel,
  close,
  children,
  drawer = false,
}: {
  title: string;
  closeLabel: string;
  close: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement);
  const dismiss = () => {
    ref.current?.close();
    if (opener.current instanceof HTMLElement) opener.current.focus();
    close();
  };
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "drawer" : undefined}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <header>
        <h2>{title}</h2>
        <Button variant="ghost" aria-label={closeLabel} onClick={dismiss}>
          <X size={18} />
        </Button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Geometry({ seed }: { seed: number }) {
  const x = 72 + (seed % 4) * 16;
  return (
    <svg
      className="geometry"
      aria-hidden="true"
      viewBox="0 0 416 192"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <path
        d={`M0 144H${x}V48H288V112H416 M${x} 144H240Q256 144 256 160V192 M288 48V16H384`}
      />
      <path d="M376 16h16m-8-8v16M32 32h16m-8-8v16M336 160h16m-8-8v16" />
      <rect x={x - 4} y="44" width="8" height="8" />
      <rect x="284" y="108" width="8" height="8" />
      <circle cx="240" cy="144" r="3" />
      <path d="M112 136v16m16-12v8m16-8v8m16-8v8m16-8v8" />
    </svg>
  );
}
export function Sparkline({ value, seed }: { value: number; seed: number }) {
  const points = Array.from(
    { length: 15 },
    (_, i) =>
      `${i * 5},${value === 0 ? 16 : Math.max(2, Math.min(19, 16 - value / 7 + ((i * i + seed * 3 + i * seed) % 11) - 5))}`,
  ).join(" ");
  return (
    <svg viewBox="0 0 70 21" className="spark" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DotGrid() {
  const id = useId();
  return (
    <svg className="dot-grid" aria-hidden="true" width="100%" height="100%">
      <defs>
        <pattern id={id} width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="8" cy="8" r="1" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
export function TextInput(props: React.ComponentProps<"input">) {
  return (
    <input {...props} className={`field-input ${props.className ?? ""}`} />
  );
}
export function Select(props: React.ComponentProps<"select">) {
  return <select {...props} />;
}
export function Check({
  label,
  switchMode = false,
  ...props
}: React.ComponentProps<"input"> & { label: string; switchMode?: boolean }) {
  return (
    <label className="check">
      <input
        {...props}
        type="checkbox"
        role={switchMode ? "switch" : undefined}
      />
      {label}
    </label>
  );
}
export function Badge({
  variant,
  children,
}: {
  variant: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge ${variant}`}>
      <i />
      {children}
    </span>
  );
}
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <span className="tooltip">
      <button type="button" aria-describedby={id}>
        {children}
      </button>
      <span id={id} role="tooltip">
        {label}
      </span>
    </span>
  );
}
export function Toast({ children }: { children: ReactNode }) {
  return <output className="toast">{children}</output>;
}
export function Skeleton({ label }: { label: string }) {
  return (
    <output className="skeleton">
      <span className="sr-only">{label}</span>
    </output>
  );
}
export function Spinner({ label }: { label: string }) {
  return (
    <output className="spinner">
      <LoaderCircle size={16} aria-hidden="true" />
      {label}
    </output>
  );
}
export function Pagination({
  label,
  previous,
  next,
  page,
  total,
  onChange,
}: {
  label: string;
  previous: string;
  next: string;
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="pagination" aria-label={label}>
      <Button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {previous}
      </Button>
      <output>
        {page} / {total}
      </output>
      <Button disabled={page >= total} onClick={() => onChange(page + 1)}>
        {next}
      </Button>
    </nav>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { key: string; label: string; panel: ReactNode }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="tabs" role="tablist" aria-labelledby={`${id}-label`}>
        <span className="sr-only" id={`${id}-label`}>
          {items.map((item) => item.label).join(" / ")}
        </span>
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-controls={`${id}-panel-${i}`}
            aria-selected={item.key === value}
            tabIndex={item.key === value ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => {
              const offset =
                e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? items.length - 1
                    : offset
                      ? (i + offset + items.length) % items.length
                      : -1;
              if (next < 0) return;
              e.preventDefault();
              onChange(items[next].key);
              document.getElementById(`${id}-tab-${next}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item, i) => (
        <section
          key={item.key}
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          role="tabpanel"
          tabIndex={item.key === value ? 0 : -1}
          hidden={item.key !== value}
        >
          {item.panel}
        </section>
      ))}
    </div>
  );
}
