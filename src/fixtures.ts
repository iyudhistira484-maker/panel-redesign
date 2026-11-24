export type State = "running" | "starting" | "stopped" | "offline";
export type Workload = "minecraft" | "bot" | "web" | "generic";
export type Server = {
  name: string;
  type: Workload;
  node: string;
  address: string;
  state: State;
  values: [number, number, number];
};
export const servers: Server[] = [
  {
    name: "Atlas Survival",
    type: "minecraft",
    node: "sgp-01",
    address: "192.0.2.10:25565",
    state: "running",
    values: [34, 61, 42],
  },
  {
    name: "Beacon Bot",
    type: "bot",
    node: "sgp-01",
    address: "192.0.2.10:3010",
    state: "running",
    values: [8, 26, 15],
  },
  {
    name: "Northstar API",
    type: "web",
    node: "jkt-02",
    address: "192.0.2.24:8080",
    state: "running",
    values: [22, 47, 31],
  },
  {
    name: "Atlas Creative",
    type: "minecraft",
    node: "jkt-02",
    address: "192.0.2.24:25566",
    state: "stopped",
    values: [0, 0, 18],
  },
  {
    name: "Forge Worker",
    type: "generic",
    node: "sgp-01",
    address: "192.0.2.10:9010",
    state: "starting",
    values: [12, 33, 21],
  },
  {
    name: "Archive Mirror",
    type: "generic",
    node: "jkt-03",
    address: "192.0.2.32:8081",
    state: "offline",
    values: [0, 0, 0],
  },
];
