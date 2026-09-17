const chartStub = {
  setOption: jest.fn(),
  resize: jest.fn(),
  dispose: jest.fn(),
  getDataURL: jest.fn(() => 'data:image/png;base64,'),
};

function use() {}
function init() {
  return chartStub;
}

module.exports = {
  __esModule: true,
  use,
  init,
  BarChart: {},
  GaugeChart: {},
  PieChart: {},
  RadarChart: {},
  GridComponent: {},
  LegendComponent: {},
  TitleComponent: {},
  TooltipComponent: {},
  CanvasRenderer: {},
  default: { use, init },
};
