import { PasswordRecovery } from "./reset-password";
import { AuthFlow } from "./auth-flow";
import { useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Database,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  List,
  Menu,
  Network,
  Radio,
  Search,
  Server as ServerIcon,
  Settings,
  Terminal,
  X,
  Bot,
  Box,
} from "lucide-react";
import {
  config,
  readLocale,
  saveLocale,
  translate,
  type Key,
  type Locale,
} from "./i18n";
import { servers, type Server, type State } from "./fixtures";
import {
  Badge,
  Button,
  Check,
  DotGrid,
  Geometry,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Sparkline,
  Spinner,
  Tabs,
  TextInput,
  Toast,
  Tooltip,
} from "./ui";

import "./style.css";

const states = ["running", "starting", "stopped", "offline"] as const;
const types = { minecraft: Boxes, bot: Bot, web: Globe, generic: Box };
const metrics = ["cpu", "ram", "disk"] as const;
const pages = [
  "overview",
  "servers",
  "nodes",
  "activity",
  "settings",
  "authView",
  "forgot-password",
  "reset-password",
  "emptyView",
  "errorView",
] as const;
type Page = (typeof pages)[number];
function getPage(): Page {
  const p = location.hash.slice(1).split("?", 1)[0] as Page;
  return pages.includes(p) ? p : location.hash ? "errorView" : "overview";
}
function App() {
  const contentId = useId();
  const [sampleTab, setSampleTab] = useState("settings");
  const [samplePage, setSamplePage] = useState(1);
  const [locale, setLocale] = useState<Locale>(readLocale),
    [page, setPage] = useState<Page>(getPage),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState<State | "all">("all"),
    [isGrid, setGrid] = useState(false),
    [drawer, setDrawer] = useState(false),
    [selected, setSelected] = useState<Server | null>(null);
  const t = (key: Key) => translate(locale, key);
  const number = (n: number) =>
    new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(n);
  useEffect(() => {
    const update = () => {
      setPage(getPage());
      setDrawer(false);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = config.name;
    saveLocale(locale);
  }, [locale]);
  const current = servers.filter(
    (s) =>
      (filter === "all" || s.state === filter) &&
      `${s.name} ${s.node} ${s.address}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const reset = () => {
    setSearch("");
    setFilter("all");
  };
  const brand = (
    <a className="brand" href="#overview">
      <span className="brand-mark">
        <Network size={19} />
      </span>
      {config.name}
      <small> / PANEL</small>
    </a>
  );
  const nav = (view: Page, label: Key, Icon: typeof Network) => (
    <a
      aria-current={page === view ? "page" : undefined}
      className="nav-link"
      href={`#${view}`}
      onClick={() => setDrawer(false)}
    >
      <Icon size={17} />
      {t(label)}
      {page === view && <ChevronRight size={14} className="nav-arrow" />}
    </a>
  );
  const navigation = (
    <>
      <div className="nav-group">
        <span>{t("workspace")}</span>
        {nav("overview", "overview", LayoutDashboard)}
        {nav("servers", "servers", ServerIcon)}
      </div>
      <div className="nav-group">
        <span>{t("operations")}</span>
        {nav("nodes", "nodes", Network)}
        {nav("activity", "activity", Activity)}
        {nav("settings", "settings", Settings)}
      </div>
      <div className="nav-group previews">
        <span>{t("layouts")}</span>
        {nav("authView", "authView", Terminal)}
        {nav("emptyView", "emptyView", Database)}
        {nav("errorView", "errorView", CircleHelp)}
      </div>
    </>
  );
  const language = (
    <div className="language">
      <Globe size={15} />
      <Select
        aria-label={t("language")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        <option value="id">Bahasa Indonesia</option>
        <option value="en">English</option>
      </Select>
      <ChevronDown size={13} />
    </div>
  );
  const state = (s: State) => <Badge variant={s}>{t(s)}</Badge>;
  const header = (title: Key, desc: Key, art = false) => (
    <section className={`page-header ${art ? "decorated" : ""}`}>
      {art && (
        <>
          <DotGrid />
          <Geometry seed={3} />
        </>
      )}
      <div>
        <div className="eyebrow">
          <span />
          {t("kub")}
        </div>
        <h1>{t(title)}</h1>
        <p>{t(desc)}</p>
      </div>
      <div className="snapshot">
        <Radio size={14} />
        {t("updated")}
      </div>
    </section>
  );
  const empty = (
    <div className="empty">
      <Geometry seed={1} />
      <Search size={22} />
      <h2>{t("empty")}</h2>
      <p>{t("emptyDesc")}</p>
      {page !== "emptyView" && <Button onClick={reset}>{t("clear")}</Button>}
    </div>
  );
  const usage = (s: Server, i: number) => (
    <div className={`usage ${s.values[i] === 0 ? "zero" : ""}`}>
      <Sparkline value={s.values[i]} seed={s.name.length + i} />
      <span>
        {s.values[i]}
        <small>%</small>
      </span>
    </div>
  );
  const name = (s: Server) => {
    const Icon = types[s.type];
    return (
      <div className="server-name">
        <span className="type-icon">
          <Icon size={17} />
        </span>
        <div>
          <button
            type="button"
            className="name-button"
            onClick={() => setSelected(s)}
          >
            {s.name}
          </button>
          <small>{t(s.type)}</small>
        </div>
      </div>
    );
  };
  const dashboard = (
    <>
      {header(page === "servers" ? "inventory" : "dashboard", "intro", true)}
      {page === "overview" && (
        <section className="fleet" aria-label={t("fleet")}>
          <div className="fleet-label">
            <Activity size={16} />
            <span>{t("fleet")}</span>
          </div>
          <div className="fleet-metrics">
            {(["total", ...states] as const).map((s) => (
              <div key={s} className="fleet-cell">
                <span>
                  <i className={s} />
                  {t(s)}
                </span>
                <strong>
                  {number(
                    s === "total"
                      ? servers.length
                      : servers.filter((r) => r.state === s).length,
                  )}
                </strong>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="inventory">
        <div className="inventory-head">
          <div>
            <h2>{t("inventory")}</h2>
            <span className="count">{number(current.length)}</span>
          </div>
          <span className="fixture-label">
            <i />
            {t("notice")}
          </span>
        </div>
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <TextInput
              aria-label={t("search")}
              placeholder={t("search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <Button
                variant="ghost"
                aria-label={t("clear")}
                onClick={() => setSearch("")}
              >
                <X size={15} />
              </Button>
            )}
          </div>
          <div className="filter">
            <Select
              aria-label={t("filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value as State | "all")}
            >
              <option value="all">{t("all")}</option>
              {states.map((s) => (
                <option key={s} value={s}>
                  {t(s)}
                </option>
              ))}
            </Select>
            <ChevronDown size={14} />
          </div>
          <div className="views">
            <Button
              aria-label={t("list")}
              title={t("list")}
              aria-pressed={!isGrid}
              onClick={() => setGrid(false)}
            >
              <List size={17} />
            </Button>
            <Button
              aria-label={t("grid")}
              title={t("grid")}
              aria-pressed={isGrid}
              onClick={() => setGrid(true)}
            >
              <LayoutGrid size={16} />
            </Button>
          </div>
        </div>
        {!current.length ? (
          empty
        ) : isGrid ? (
          <div className="server-grid">
            {current.map((s) => (
              <article className={`server-tile ${s.state}`} key={s.name}>
                <div>
                  {name(s)}
                  {state(s.state)}
                </div>
                <p className="mono">
                  {s.address} · {s.node}
                </p>
                <div className="tile-metrics">
                  {metrics.map((k, i) => (
                    <div key={k}>
                      <small>{t(k)}</small>
                      {usage(s, i)}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <section className="table-wrap" aria-label={t("inventory")}>
            <table>
              <thead>
                <tr>
                  {(
                    ["server", "address", "node", "status", ...metrics] as const
                  ).map((k) => (
                    <th scope="col" key={k}>
                      {t(k)}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">{t("details")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {current.map((s) => (
                  <tr key={s.name} className={s.state}>
                    <td>{name(s)}</td>
                    <td className="mono muted">{s.address}</td>
                    <td className="mono muted">{s.node}</td>
                    <td>{state(s.state)}</td>
                    {metrics.map((k, i) => (
                      <td key={k}>{usage(s, i)}</td>
                    ))}
                    <td>
                      <Button
                        variant="ghost"
                        aria-label={`${t("showDetails")}: ${s.name}`}
                        onClick={() => setSelected(s)}
                      >
                        <ArrowUpRight size={17} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <footer className="inventory-foot">
          <span aria-live="polite">
            {number(current.length)} / {number(servers.length)} ·{" "}
            {t("matching")}
          </span>
          <span>{t("noLive")}</span>
        </footer>
      </section>
    </>
  );
  const secondary =
    page === "authView" ||
    page === "forgot-password" ||
    page === "reset-password" ? (
      <section className="auth-layout">
        <div>
          {brand}
          {page === "authView" ? (
            <>
              <h1>{t("auth")}</h1>
              <p>{t("authDesc")}</p>
              <fieldset disabled>
                <label htmlFor={`${contentId}-email`}>
                  {t("email")}
                  <TextInput id={`${contentId}-email`} type="email" />
                </label>
                <label htmlFor={`${contentId}-password`}>
                  {t("password")}
                  <TextInput id={`${contentId}-password`} type="password" />
                </label>
                <Button variant="primary">{t("auth")}</Button>
              </fieldset>
              <a className="button ghost" href="#forgot-password">
                {locale === "id" ? "Lupa kata sandi" : "Forgot password"}
              </a>
            </>
          ) : (
            <PasswordRecovery
              key={page}
              mode={page === "forgot-password" ? "forgot" : "reset"}
              locale={locale}
            />
          )}
        </div>
        <div className="auth-art decorated">
          <DotGrid />
          <AuthFlow t={t} />
        </div>
      </section>
    ) : page === "errorView" ? (
      <section className="error-layout">
        <Geometry seed={4} />
        <span className="mono">404</span>
        <h1>{t("error")}</h1>
        <p>{t("errorDesc")}</p>
        <a className="button secondary" href="#overview">
          <ArrowLeft size={16} />
          {t("back")}
        </a>
      </section>
    ) : page === "emptyView" ? (
      <>
        {header("emptyView", "emptyDesc")}
        {empty}
      </>
    ) : page === "settings" ? (
      <>
        {header("account", "accountDesc")}
        <div className="settings-row">
          <h2>{t("language")}</h2>
          {language}
        </div>
        <section className="component-preview" aria-label={t("example")}>
          <h2>{t("example")}</h2>
          <Tabs
            value={sampleTab}
            onChange={setSampleTab}
            items={[
              {
                key: "settings",
                label: t("settings"),
                panel: (
                  <div className="component-row">
                    <Check label={t("enabled")} />
                    <Check label={t("preview")} switchMode />
                    <Tooltip label={t("sample")}>
                      <CircleHelp size={16} />
                    </Tooltip>
                    <Toast>{t("notice")}</Toast>
                  </div>
                ),
              },
              {
                key: "preview",
                label: t("preview"),
                panel: (
                  <div className="component-row">
                    <Spinner label={t("loading")} />
                    <Skeleton label={t("loading")} />
                    <Pagination
                      label={t("pagination")}
                      previous={t("previous")}
                      next={t("next")}
                      page={samplePage}
                      total={3}
                      onChange={setSamplePage}
                    />
                  </div>
                ),
              },
            ]}
          />
        </section>
      </>
    ) : (
      <>
        {header(page, "workspaceDesc")}
        <div className="dense">
          <Terminal size={17} />
          <h2>{t("workspaceView")}</h2>
          <span className="mono">{t("sample")}</span>
        </div>
      </>
    );
  return (
    <>
      <button
        type="button"
        className="skip"
        onClick={() => {
          document.getElementById(contentId)?.focus();
        }}
      >
        {t("skip")}
      </button>
      <div className="shell">
        <aside className="sidebar">
          {brand}
          <div className="workspace">
            <span>
              <Command size={16} />
            </span>
            <div>
              {t("workspace")}
              <small>{t("demo")}</small>
            </div>
          </div>
          <nav aria-label={t("sections")}>{navigation}</nav>
          <div className="sidebar-foot">
            <span className="environment-dot" />
            {t("environment")}
          </div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <Button
              className="menu"
              aria-label={t("menu")}
              variant="ghost"
              onClick={() => setDrawer(true)}
            >
              <Menu size={20} />
            </Button>
            <div className="breadcrumbs">
              <span>{config.name}</span>
              <ChevronRight size={14} />
              <strong>
                {t(
                  page === "forgot-password" || page === "reset-password"
                    ? "authView"
                    : page,
                )}
              </strong>
            </div>
            {language}
            <span className="avatar" aria-hidden="true">
              {config.name.slice(0, 1)}
            </span>
          </header>
          <main id={contentId} tabIndex={-1}>
            {page === "overview" || page === "servers" ? dashboard : secondary}
          </main>
        </div>
      </div>
      {drawer && (
        <Modal
          drawer
          title={t("sections")}
          closeLabel={t("close")}
          close={() => setDrawer(false)}
        >
          <nav aria-label={t("sections")}>{navigation}</nav>
        </Modal>
      )}
      {selected && (
        <Modal
          title={selected.name}
          closeLabel={t("close")}
          close={() => setSelected(null)}
        >
          <div className="details">
            <div>
              <span>{t("workload")}</span>
              <strong>{t(selected.type)}</strong>
            </div>
            <div>
              <span>{t("address")}</span>
              <strong className="mono">{selected.address}</strong>
            </div>
            <div>
              <span>{t("node")}</span>
              <strong className="mono">{selected.node}</strong>
            </div>
            <div>
              <span>{t("status")}</span>
              {state(selected.state)}
            </div>
            <div>
              <span>
                {t("cpu")} / {t("ram")} / {t("disk")}
              </span>
              <strong className="mono">
                {selected.values.map((n) => `${n}%`).join(" / ")}
              </strong>
            </div>
          </div>
          <p>{t("notice")}</p>
        </Modal>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
