import {
  ArrowDownToLine,
  ClipboardList,
  CornerDownRight,
  Server,
  Pause,
  Play,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import type { Key } from "./i18n";

const paths = [
  "M136 144H170",
  "M302 144H318V100H338 M302 144H318V188H338",
  "M488 100H504V144H524 M488 188H504V144H524",
];
const steps = [
  { key: "flowRequest", x: 16, y: 122, w: 120, Icon: ArrowDownToLine },
  { key: "flowPolicy", x: 170, y: 122, w: 132, Icon: ShieldCheck },
  { key: "flowNode", x: 338, y: 78, w: 150, Icon: Server },
  { key: "flowAudit", x: 338, y: 166, w: 150, Icon: ClipboardList },
  { key: "flowReady", x: 524, y: 122, w: 110, Icon: CornerDownRight },
] as const;

export function AuthFlow({ t }: { t: (key: Key) => string }) {
  const [paused, setPaused] = useState(false);
  const MotionIcon = paused ? Play : Pause;
  return (
    <div className="auth-flow" data-paused={paused}>
      <div className="auth-flow-heading">
        <span>{t("flowTitle")}</span>
        <div className="auth-flow-tools">
          <span>{t("flowDemo")}</span>
          <button
            type="button"
            className="auth-flow-toggle"
            onClick={() => setPaused(!paused)}
          >
            <MotionIcon size={14} aria-hidden="true" />
            {t(paused ? "flowPlay" : "flowPause")}
          </button>
        </div>
      </div>
      <svg aria-hidden="true" viewBox="0 46 650 196" fill="none">
        {paths.map((d) => (
          <path className="auth-link" d={d} key={d} />
        ))}
        {paths.map((d) => (
          <path className="auth-signal" pathLength="1" d={d} key={d} />
        ))}
        {steps.map(({ key, x, y, w, Icon }, index) => (
          <g
            className="auth-stage"
            data-stage={[0, 1, 2, 2, 3][index]}
            key={key}
            transform={`translate(${x} ${y})`}
          >
            <rect className="auth-step" width={w} height="44" rx="6" />
            <rect
              className="auth-icon-tile"
              x="8"
              y="9"
              width="26"
              height="26"
              rx="4"
            />
            <Icon x={13} y={14} width={16} height={16} strokeWidth={1.5} />
            <text x="41" y="26">
              {t(key)}
            </text>
          </g>
        ))}
        <circle className="auth-junction" cx="318" cy="144" r="3" />
        <circle className="auth-junction" cx="504" cy="144" r="3" />
      </svg>
    </div>
  );
}
