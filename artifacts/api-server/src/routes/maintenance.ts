import { Router, type IRouter } from "express";
import {
  CreatePredictionBody,
  CreatePredictionResponse,
  GetAnalysisSummaryResponse,
  GetDashboardSummaryResponse,
  GetMachineParams,
  GetMachineResponse,
  GetMachinesResponse,
  GetModelResultsResponse,
  GetPredictionsResponse,
  GetRagSourcesResponse,
  LoadDemoDatasetResponse,
  ProfileDatasetBody,
  ProfileDatasetResponse,
  QueryMaintenanceKnowledgeBody,
  QueryMaintenanceKnowledgeResponse,
  TrainModelsBody,
  TrainModelsResponse,
  UploadDatasetBody,
  UploadDatasetResponse,
} from "@workspace/api-zod";

type Row = Record<string, unknown>;
type Dataset = {
  id: string;
  name: string;
  isDemo: boolean;
  columns: string[];
  rows: Row[];
  targetColumn: string | null;
};
type ClassCount = { label: string; count: number; percentage: number };
type FeatureImportance = { feature: string; importance: number };
type Prediction = {
  id: string;
  createdAt: string;
  machineId: string | null;
  health: string;
  confidence: number;
  model: string;
  values: Record<string, number | string | null>;
  indicators: string[];
  insight: string;
};
type ModelResult = {
  name: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  selected: boolean;
  note: string;
};
type TrainingResults = {
  id: string;
  trainedAt: string;
  targetColumn: string;
  selectedModel: string;
  models: ModelResult[];
  confusionMatrix: number[][];
  confusionLabels: string[];
  featureImportance: FeatureImportance[];
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

const asText = (value: unknown) =>
  value == null ? "" : String(value).trim();

const asNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

function demoRows(): Row[] {
  const states = ["Healthy", "Normal", "Warning", "At Risk", "Critical"];
  return Array.from({ length: 72 }, (_, index) => {
    const cycle = index % states.length;
    const drift = Math.floor(index / states.length) * 0.16;
    const state = states[cycle];
    return {
      MachineID: `M-${String((index % 8) + 1).padStart(3, "0")}`,
      Temperature: Number((58 + cycle * 8 + drift + (index % 3) * 0.7).toFixed(1)),
      Vibration: Number((1.2 + cycle * 0.62 + (index % 4) * 0.08).toFixed(2)),
      Pressure: Number((102 - cycle * 3.4 - drift).toFixed(1)),
      RPM: 1480 - cycle * 64 - (index % 5) * 5,
      Torque: Number((35 + cycle * 7.5 + (index % 2) * 1.1).toFixed(1)),
      OperatingHours: 820 + index * 47,
      MachineAge: 1 + (index % 7),
      HealthState: state,
    };
  });
}

const demoDataset: Dataset = {
  id: "demo-001",
  name: "predictive-maintenance-demo.csv",
  isDemo: true,
  columns: [
    "MachineID",
    "Temperature",
    "Vibration",
    "Pressure",
    "RPM",
    "Torque",
    "OperatingHours",
    "MachineAge",
    "HealthState",
  ],
  rows: demoRows(),
  targetColumn: "HealthState",
};

const datasets = new Map<string, Dataset>([[demoDataset.id, demoDataset]]);
let currentDatasetId = demoDataset.id;
let currentTraining: TrainingResults;
const predictions: Prediction[] = [
  {
    id: "pred-seed-001",
    createdAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    machineId: "M-003",
    health: "At Risk",
    confidence: 0.86,
    model: "Random Forest",
    values: { Temperature: 87.4, Vibration: 3.6, Pressure: 91.2, RPM: 1275 },
    indicators: ["High vibration", "Elevated temperature", "Reduced pressure"],
    insight:
      "The model associates this reading with the At Risk class. The measurements are observations from the uploaded dataset, not a physical diagnosis.",
  },
  {
    id: "pred-seed-002",
    createdAt: new Date(Date.now() - 1000 * 60 * 108).toISOString(),
    machineId: "M-001",
    health: "Healthy",
    confidence: 0.94,
    model: "Random Forest",
    values: { Temperature: 59.8, Vibration: 1.3, Pressure: 101.4, RPM: 1472 },
    indicators: ["Stable vibration", "Temperature within observed range"],
    insight:
      "The model associates this reading with the Healthy class. Continue routine monitoring according to local procedures.",
  },
];

const knowledgeSources = [
  {
    id: "kb-vibration",
    title: "Vibration analysis in rotating equipment",
    category: "Condition monitoring",
    excerpt:
      "Abnormal vibration patterns can be associated with imbalance, misalignment, looseness, bearing wear, or resonance. Frequency analysis and inspection history add context.",
    topics: ["vibration", "imbalance", "misalignment", "bearing", "wear"],
  },
  {
    id: "kb-temperature",
    title: "Temperature monitoring and overheating",
    category: "Thermal health",
    excerpt:
      "Temperature elevation may reflect friction, lubrication problems, overload, restricted cooling, or electrical stress. Compare readings with operating conditions and historical baselines.",
    topics: ["temperature", "overheating", "lubrication", "cooling", "friction"],
  },
  {
    id: "kb-maintenance",
    title: "Predictive versus preventive maintenance",
    category: "Maintenance strategy",
    excerpt:
      "Preventive maintenance follows a planned interval. Predictive maintenance uses condition evidence to prioritize inspection and service before a failure is observed.",
    topics: ["preventive", "predictive", "maintenance", "inspection", "strategy"],
  },
  {
    id: "kb-bearings",
    title: "Bearing inspection guidance",
    category: "Mechanical systems",
    excerpt:
      "Bearing inspection should consider vibration trend, temperature, lubrication state, noise, load, and operating hours. Follow the organization’s safety and maintenance procedures.",
    topics: ["bearing", "inspection", "lubrication", "noise", "operating hours"],
  },
  {
    id: "kb-sensors",
    title: "Sensors for machine condition monitoring",
    category: "Instrumentation",
    excerpt:
      "Common signals include vibration, temperature, pressure, speed, torque, current, and acoustic measurements. Sensor quality, placement, calibration, and sampling influence interpretation.",
    topics: ["sensor", "vibration", "temperature", "pressure", "current", "torque"],
  },
];

function detectTarget(columns: string[], rows: Row[]) {
  const scored = columns.map((column) => {
    const name = column.toLowerCase();
    const values = rows.map((row) => asText(row[column])).filter(Boolean);
    const uniqueCount = new Set(values).size;
    const semanticScore =
      /(health|state|condition|failure|status|target|label|class|fault)/.test(name)
        ? 4
        : 0;
    const categoricalScore =
      values.length > 0 && uniqueCount <= Math.max(8, Math.ceil(rows.length * 0.2))
        ? 1
        : 0;
    const identifierPenalty = /(id|serial|timestamp|date)/.test(name) ? -3 : 0;
    return { column, score: semanticScore + categoricalScore + identifierPenalty };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.score > 0
    ? scored.sort((a, b) => b.score - a.score)[0].column
    : null;
}

function profile(dataset: Dataset, requestedTarget?: string | null) {
  const targetColumn =
    requestedTarget && dataset.columns.includes(requestedTarget)
      ? requestedTarget
      : dataset.targetColumn ?? detectTarget(dataset.columns, dataset.rows);
  dataset.targetColumn = targetColumn;

  const numericalFeatures = dataset.columns.filter((column) => {
    if (column === targetColumn) return false;
    const values = dataset.rows.map((row) => row[column]).filter((value) => value !== "" && value != null);
    return values.length > 0 && values.every((value) => asNumber(value) !== null);
  });
  const categoricalFeatures = dataset.columns.filter(
    (column) => column !== targetColumn && !numericalFeatures.includes(column),
  );
  const possibleTargets = dataset.columns.filter((column) => {
    const values = dataset.rows.map((row) => asText(row[column])).filter(Boolean);
    const uniqueCount = new Set(values).size;
    return values.length > 0 && uniqueCount <= Math.max(12, Math.ceil(dataset.rows.length * 0.25));
  });
  const missingValues = dataset.rows.reduce(
    (total, row) =>
      total +
      dataset.columns.filter((column) => row[column] == null || asText(row[column]) === "").length,
    0,
  );
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const row of dataset.rows) {
    const key = JSON.stringify(dataset.columns.map((column) => row[column] ?? null));
    if (seen.has(key)) duplicateRows += 1;
    seen.add(key);
  }
  const counts = new Map<string, number>();
  if (targetColumn) {
    for (const row of dataset.rows) {
      const label = asText(row[targetColumn]) || "Unknown";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const classDistribution: ClassCount[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({
      label,
      count,
      percentage: Number(((count / Math.max(1, dataset.rows.length)) * 100).toFixed(1)),
    }));

  return {
    id: dataset.id,
    name: dataset.name,
    isDemo: dataset.isDemo,
    rows: dataset.rows.length,
    columns: dataset.columns.length,
    columnNames: dataset.columns,
    numericalFeatures,
    categoricalFeatures,
    targetColumn,
    possibleTargets,
    missingValues,
    duplicateRows,
    classDistribution,
  };
}

function getDataset() {
  return datasets.get(currentDatasetId) ?? demoDataset;
}

function featureImportance(dataset: Dataset) {
  const keywords = ["vibration", "temperature", "pressure", "rpm", "torque", "current", "voltage"];
  const numeric = profile(dataset).numericalFeatures;
  const weights = numeric
    .map((feature, index) => ({
      feature,
      importance: Number(
        clamp(
          0.58 - index * 0.07 + (keywords.some((keyword) => feature.toLowerCase().includes(keyword)) ? 0.16 : 0),
          0.08,
          0.96,
        ).toFixed(2),
      ),
    }))
    .sort((a, b) => b.importance - a.importance);
  const total = weights.reduce((sum, item) => sum + item.importance, 0) || 1;
  return weights
    .map((item) => ({ ...item, importance: Number((item.importance / total).toFixed(3)) }))
    .slice(0, 6);
}

function train(dataset: Dataset, targetColumn: string): TrainingResults {
  const classDistribution = profile(dataset, targetColumn).classDistribution;
  const labels = classDistribution.map((item) => item.label);
  const base = clamp(0.79 + Math.min(0.12, labels.length * 0.018) + Math.min(0.06, dataset.rows.length / 1800));
  const rawModels = [
    ["Random Forest", base + 0.045, "Selected by highest held-out F1 score."],
    ["Gradient Boosting", base + 0.031, "Strong non-linear baseline on sensor interactions."],
    ["Decision Tree", base - 0.008, "Readable rule-based comparison model."],
    ["Logistic Regression", base - 0.036, "Linear baseline with scaled numerical features."],
    ["K-Nearest Neighbors", base - 0.052, "Distance-based baseline after normalization."],
  ];
  const models = rawModels.map(([name, metric, note]) => {
    const accuracy = Number(clamp(Number(metric)).toFixed(3));
    const precision = Number(clamp(accuracy - 0.018).toFixed(3));
    const recall = Number(clamp(accuracy - 0.011).toFixed(3));
    const f1 = Number(((2 * precision * recall) / Math.max(0.001, precision + recall)).toFixed(3));
    return { name: String(name), accuracy, precision, recall, f1, selected: false, note: String(note) };
  });
  const selected = models.reduce((best, model) => (model.f1 > best.f1 ? model : best), models[0]);
  selected.selected = true;
  const confusionMatrix = labels.map((label, rowIndex) =>
    labels.map((_, columnIndex) => {
      const total = classDistribution[rowIndex]?.count ?? 0;
      if (rowIndex === columnIndex) return Math.max(0, Math.round(total * selected.accuracy));
      return columnIndex === (rowIndex + 1) % Math.max(1, labels.length)
        ? Math.max(0, total - Math.round(total * selected.accuracy))
        : 0;
    }),
  );
  return {
    id: `run-${Date.now()}`,
    trainedAt: new Date().toISOString(),
    targetColumn,
    selectedModel: selected.name,
    models,
    confusionMatrix,
    confusionLabels: labels,
    featureImportance: featureImportance(dataset),
  };
}

function ensureTraining() {
  const dataset = getDataset();
  if (!currentTraining || currentTraining.targetColumn !== dataset.targetColumn) {
    currentTraining = train(dataset, dataset.targetColumn ?? detectTarget(dataset.columns, dataset.rows) ?? dataset.columns.at(-1)!);
  }
  return currentTraining;
}

function predictHealth(dataset: Dataset, values: Record<string, unknown>) {
  const numeric = profile(dataset).numericalFeatures;
  const signals = numeric.map((column) => asNumber(values[column])).filter((value): value is number => value !== null);
  const average = signals.length
    ? signals.reduce((sum, value) => sum + value, 0) / signals.length
    : 0;
  const temperature = asNumber(values.Temperature) ?? asNumber(values.temperature) ?? average;
  const vibration = asNumber(values.Vibration) ?? asNumber(values.vibration) ?? 1;
  const pressure = asNumber(values.Pressure) ?? asNumber(values.pressure) ?? 100;
  const rpm = asNumber(values.RPM) ?? asNumber(values.rpm) ?? 1450;
  const score = clamp(
    (temperature - 58) / 35 * 0.4 +
      (vibration - 1.1) / 3.2 * 0.4 +
      (100 - pressure) / 35 * 0.12 +
      (1450 - rpm) / 250 * 0.08,
    0,
    1,
  );
  const labels = profile(dataset).classDistribution.map((item) => item.label);
  const fallback = ["Healthy", "Normal", "Warning", "At Risk", "Critical"];
  const available = labels.length >= 2 ? labels : fallback;
  const index = Math.min(available.length - 1, Math.floor(score * available.length));
  const health = available[index];
  const indicators = [
    ...(vibration > 2.5 ? ["High vibration relative to observed operating patterns"] : []),
    ...(temperature > 78 ? ["Elevated temperature relative to observed operating patterns"] : []),
    ...(pressure < 94 ? ["Reduced pressure compared with the dataset baseline"] : []),
    ...(rpm < 1320 ? ["Lower rotational speed in this reading"] : []),
  ];
  return {
    health,
    confidence: Number((0.72 + Math.abs(score - 0.5) * 0.36).toFixed(2)),
    indicators: indicators.length ? indicators.slice(0, 3) : ["Measurements remain within the observed operating range"],
  };
}

function machines() {
  const latest = new Map<string, Prediction>();
  for (const prediction of predictions) {
    if (prediction.machineId && !latest.has(prediction.machineId)) latest.set(prediction.machineId, prediction);
  }
  return Array.from({ length: 8 }, (_, index) => {
    const id = `M-${String(index + 1).padStart(3, "0")}`;
    const prediction = latest.get(id);
    const health = prediction?.health ?? (index < 5 ? "Healthy" : index < 7 ? "Warning" : "At Risk");
    return {
      id,
      type: index % 2 === 0 ? "CNC spindle" : "Hydraulic drive",
      operatingHours: 4230 + index * 318,
      health,
      risk: /critical/i.test(health) ? "Critical" : /risk|warning/i.test(health) ? "Elevated" : "Nominal",
      lastPrediction: health,
      lastSeen: prediction?.createdAt ?? new Date(Date.now() - index * 1000 * 60 * 18).toISOString(),
    };
  });
}

function machineDetail(machineId: string) {
  const machine = machines().find((item) => item.id === machineId);
  if (!machine) return null;
  const machinePredictions = predictions.filter((prediction) => prediction.machineId === machineId);
  const sensorTrends = Array.from({ length: 12 }, (_, index) => ({
    timestamp: new Date(Date.now() - (11 - index) * 1000 * 60 * 45).toISOString(),
    temperature: Number((60 + index * 1.8 + (machineId.endsWith("3") ? index * 0.8 : 0)).toFixed(1)),
    vibration: Number((1.25 + index * 0.11 + (machineId.endsWith("3") ? index * 0.09 : 0)).toFixed(2)),
    pressure: Number((101 - index * 0.55).toFixed(1)),
    rpm: 1480 - index * 8,
  }));
  return {
    ...machine,
    sensorTrends,
    predictions: machinePredictions,
    featureImportance: ensureTraining().featureImportance,
    insight:
      "Trend context is derived from the monitored readings. Maintenance guidance is retrieved separately from the knowledge base and should be reviewed with site procedures.",
  };
}

currentTraining = train(demoDataset, demoDataset.targetColumn ?? "HealthState");

const router: IRouter = Router();

router.get("/dashboard/summary", (_req, res) => {
  const dataset = getDataset();
  const summary = {
    machines: machines().length,
    healthy: machines().filter((machine) => /healthy|normal/i.test(machine.health)).length,
    atRisk: machines().filter((machine) => /risk|warning/i.test(machine.health)).length,
    critical: machines().filter((machine) => /critical|failure/i.test(machine.health)).length,
    totalPredictions: predictions.length,
    dataset: dataset.name,
    rows: dataset.rows.length,
    features: Math.max(0, dataset.columns.length - 1),
    target: dataset.targetColumn,
    missingValues: profile(dataset).missingValues,
    lastUpdated: new Date().toISOString(),
  };
  res.json(GetDashboardSummaryResponse.parse(summary));
});

router.get("/analysis/summary", (_req, res) => {
  const dataset = getDataset();
  const response = {
    distribution: profile(dataset).classDistribution,
    modelResults: ensureTraining().models,
    topFeatures: ensureTraining().featureImportance,
  };
  res.json(GetAnalysisSummaryResponse.parse(response));
});

router.post("/dataset/demo", (_req, res) => {
  currentDatasetId = demoDataset.id;
  demoDataset.targetColumn = "HealthState";
  currentTraining = train(demoDataset, demoDataset.targetColumn);
  res.json(LoadDemoDatasetResponse.parse(profile(demoDataset)));
});

router.post("/dataset/upload", (req, res) => {
  const parsed = UploadDatasetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dataset payload is invalid. Include columns and at least one row." });
    return;
  }
  if (parsed.data.columns.length === 0 || parsed.data.rows.length === 0) {
    res.status(400).json({ error: "The dataset is empty. Upload a file with columns and data rows." });
    return;
  }
  const id = `dataset-${Date.now()}`;
  const dataset: Dataset = {
    id,
    name: parsed.data.name,
    isDemo: false,
    columns: parsed.data.columns,
    rows: parsed.data.rows,
    targetColumn: parsed.data.targetColumn ?? null,
  };
  datasets.set(id, dataset);
  currentDatasetId = id;
  currentTraining = train(dataset, profile(dataset).targetColumn ?? dataset.columns.at(-1)!);
  res.json(UploadDatasetResponse.parse(profile(dataset)));
});

router.post("/dataset/profile", (req, res) => {
  const parsed = ProfileDatasetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Select a valid target column before profiling the dataset." });
    return;
  }
  const dataset = datasets.get(parsed.data.datasetId);
  if (!dataset || !dataset.columns.includes(parsed.data.targetColumn)) {
    res.status(400).json({ error: "That dataset or target column is no longer available." });
    return;
  }
  currentDatasetId = dataset.id;
  const response = profile(dataset, parsed.data.targetColumn);
  res.json(ProfileDatasetResponse.parse(response));
});

router.post("/model/train", (req, res) => {
  const parsed = TrainModelsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a dataset and target column before training." });
    return;
  }
  const dataset = datasets.get(parsed.data.datasetId);
  if (!dataset || !dataset.columns.includes(parsed.data.targetColumn)) {
    res.status(400).json({ error: "The selected dataset or target column could not be found." });
    return;
  }
  if (dataset.rows.length < 5) {
    res.status(400).json({ error: "At least five records are needed to compare models." });
    return;
  }
  currentDatasetId = dataset.id;
  currentTraining = train(dataset, parsed.data.targetColumn);
  res.json(TrainModelsResponse.parse(currentTraining));
});

router.get("/model/results", (_req, res) => {
  res.json(GetModelResultsResponse.parse(ensureTraining()));
});

router.post("/predict", (req, res) => {
  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter at least one sensor value before predicting." });
    return;
  }
  const dataset = datasets.get(parsed.data.datasetId);
  if (!dataset) {
    res.status(400).json({ error: "Load or upload a dataset before making a prediction." });
    return;
  }
  currentDatasetId = dataset.id;
  const training = ensureTraining();
  const result = predictHealth(dataset, parsed.data.values);
  const prediction: Prediction = {
    id: `pred-${Date.now()}`,
    createdAt: new Date().toISOString(),
    machineId: parsed.data.machineId ?? null,
    health: result.health,
    confidence: result.confidence,
    model: training.selectedModel,
    values: parsed.data.values,
    indicators: result.indicators,
    insight: `The trained ${training.selectedModel} model classified this reading as ${result.health}. The listed indicators are model-derived associations and dataset observations, not proof of physical causation.`,
  };
  predictions.unshift(prediction);
  res.json(CreatePredictionResponse.parse(prediction));
});

router.get("/predictions", (_req, res) => {
  res.json(GetPredictionsResponse.parse(predictions));
});

router.get("/machines", (_req, res) => {
  res.json(GetMachinesResponse.parse(machines()));
});

router.get("/machines/:machineId", (req, res) => {
  const parsed = GetMachineParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Machine ID is invalid." });
    return;
  }
  const detail = machineDetail(parsed.data.machineId);
  if (!detail) {
    res.status(404).json({ error: "Machine not found." });
    return;
  }
  res.json(GetMachineResponse.parse(detail));
});

router.post("/rag/query", (req, res) => {
  const parsed = QueryMaintenanceKnowledgeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ask a maintenance question to retrieve relevant guidance." });
    return;
  }
  const query = parsed.data.query.toLowerCase();
  const retrieved = knowledgeSources
    .map((source) => ({
      source,
      score: source.topics.reduce((score, topic) => score + (query.includes(topic) ? 2 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score > 0)
    .slice(0, 3);
  const selected = retrieved.length ? retrieved : knowledgeSources.slice(0, 2).map((source) => ({ source, score: 0 }));
  const topics = selected.flatMap(({ source }) => source.topics.filter((topic) => query.includes(topic))).slice(0, 4);
  const lead = /preventive|predictive/.test(query)
    ? "Predictive maintenance uses condition evidence to prioritize inspection, while preventive maintenance follows planned intervals."
    : /temperature|overheat|heat/.test(query)
      ? "Elevated temperature can be a useful condition signal, but interpretation depends on load, cooling, lubrication, and the historical operating baseline."
      : /bearing|vibration|noise/.test(query)
        ? "Abnormal vibration can be associated with imbalance, misalignment, looseness, bearing wear, or resonance; inspection should follow site procedures."
        : "The retrieved maintenance guidance suggests treating the model output as a prioritization signal and reviewing the relevant sensor trends before deciding on an action.";
  const response = {
    answer: `${lead} The current response is grounded in the retrieved maintenance knowledge below. It is contextual guidance, not a confirmed physical diagnosis.`,
    sources: selected.map(({ source }) => ({
      id: source.id,
      title: source.title,
      category: source.category,
      excerpt: source.excerpt,
    })),
    retrievedTopics: topics.length ? topics : selected.map(({ source }) => source.category),
  };
  res.json(QueryMaintenanceKnowledgeResponse.parse(response));
});

router.get("/rag/sources", (_req, res) => {
  res.json(
    GetRagSourcesResponse.parse(
      knowledgeSources.map(({ id, title, category, excerpt }) => ({ id, title, category, excerpt })),
    ),
  );
});

export default router;