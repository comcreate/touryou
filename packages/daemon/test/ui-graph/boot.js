// 試作のページの起動（試験の中だけで使う）。インラインの script は CSP で止まるので、別の資産にする。
var VIEW = {
  nodes: [
    {
      id: "root",
      parentId: null,
      role: "integrator",
      state: "running",
      title: "統合（いちばん上）",
    },
    {
      id: "m1",
      parentId: "root",
      role: "integrator",
      state: "running",
      title: "中間の統合",
      band: "turn",
    },
    {
      id: "a",
      parentId: "m1",
      role: "implement",
      state: "running",
      title: "実装 A <img src=x onerror=alert(1)>",
    },
    {
      id: "b",
      parentId: "m1",
      role: "implement",
      state: "verified",
      title: "実装 B",
      band: "finished",
    },
    { id: "c", parentId: "m1", role: "review", state: "running", title: "レビュー C" },
    { id: "d", parentId: "root", role: "implement", state: "running", title: "実装 D" },
    { id: "e", parentId: "root", role: "implement", state: "running" },
  ],
  flows: [
    { id: "f1", kind: "instruction", dir: "down", from: "root", to: "m1", stage: "sent" },
    {
      id: "f2",
      kind: "report",
      dir: "up",
      from: "m1",
      to: "root",
      stage: "sent",
      deliveryUnknown: true,
    },
    { id: "f3", kind: "instruction", dir: "down", from: "m1", to: "a", stage: "delivered" },
    { id: "f4", kind: "done", dir: "up", from: "b", to: "m1", stage: "done" },
    {
      id: "f5",
      kind: "decision",
      dir: "up",
      from: "c",
      to: "m1",
      stage: "sent",
      deliveryUnknown: true,
    },
    { id: "f6", kind: "instruction", dir: "down", from: "root", to: "d", stage: "done" },
  ],
};
TouryouGraph.drawGraph(document.getElementById("g"), VIEW).then(
  () => {
    document.body.dataset.ready = "1";
  },
  (e) => {
    document.body.dataset.ready = `error:${String(e)}`;
  },
);
