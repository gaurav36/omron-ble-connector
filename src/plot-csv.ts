import { basename, extname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadPlotCsv } from './storage';
import type { BloodPressureRecord } from './types';

interface Average {
  date: string;
  systolic: number;
  diastolic: number;
}

export async function createPlot(
  inputPath: string,
  options: { windowDays: number; binDays: number; outputPath?: string },
): Promise<string> {
  if (!Number.isInteger(options.windowDays) || options.windowDays < 1) {
    throw new RangeError('Window size must be a positive whole number of days');
  }
  if (!Number.isInteger(options.binDays) || options.binDays < 1) {
    throw new RangeError('Bin size must be a positive whole number of days');
  }
  const records = await loadPlotCsv(inputPath);
  if (records.length === 0) throw new Error('No records found in the CSV');
  const averages = averageValues(records, options.binDays);
  const outputPath = options.outputPath ?? join(process.cwd(), `${basename(inputPath, extname(inputPath))}.html`);
  await writeFile(outputPath, makeHtml(basename(inputPath), averages, options), 'utf8');
  return outputPath;
}

export function averageValues(records: readonly BloodPressureRecord[], binDays: number): Average[] {
  if (records.length === 0) return [];
  const sorted = [...records].sort((left, right) => left.datetime.getTime() - right.datetime.getTime());
  const start = startOfDay(sorted[0].datetime).getTime();
  const bins = new Map<number, { count: number; sys: number; dia: number; day: Date }>();
  for (const record of sorted) {
    const day = startOfDay(record.datetime);
    const index = Math.floor((day.getTime() - start) / (binDays * 86_400_000));
    const bin = bins.get(index) ?? { count: 0, sys: 0, dia: 0, day };
    bin.count++;
    bin.sys += record.sys;
    bin.dia += record.dia;
    bins.set(index, bin);
  }
  return [...bins.values()].map((bin) => ({
    date: formatDate(bin.day),
    systolic: bin.sys / bin.count,
    diastolic: bin.dia / bin.count,
  }));
}

function makeHtml(inputName: string, averages: Average[], options: { windowDays: number; binDays: number }): string {
  const data = JSON.stringify(averages);
  const visibleCount = Math.max(1, Math.ceil(options.windowDays / options.binDays));
  const title = escapeHtml(`Omron blood pressure measurements — ${inputName}`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body{font:16px system-ui,sans-serif;margin:2rem;color:#17212b}main{max-width:1100px;margin:auto}
    svg{width:100%;height:auto;border:1px solid #d8dee5;background:#fff}
    .bar{fill:#1769aa} .axis{stroke:#65727e;stroke-width:1} .label{fill:#344250;font-size:12px}
    .range{fill:#4caf50;opacity:.12} .high{fill:#ef5350;opacity:.1}
    input{width:100%;margin:1rem 0}
  </style>
</head>
<body><main>
  <h1>${title}</h1>
  <p>Average of ${options.binDays} day(s) per bar · systolic and diastolic pressure in mmHg</p>
  <svg id="chart" viewBox="0 0 1000 480" role="img" aria-label="Blood pressure chart">
    <rect class="range" x="60" y="253.3" width="920" height="133.4"/>
    <rect class="high" x="60" y="86.7" width="920" height="133.3"/>
    <g id="bars"></g><g id="labels"></g>
    <line class="axis" x1="60" y1="420" x2="980" y2="420"/>
    <line class="axis" x1="60" y1="20" x2="60" y2="420"/>
    <text class="label" x="10" y="30">180</text><text class="label" x="10" y="287">100</text>
    <text class="label" x="10" y="420">60</text>
    <text class="label" x="62" y="455">Date</text>
    <text class="label" x="12" y="240" transform="rotate(-90 12 240)">mmHg</text>
  </svg>
  <input id="offset" type="range" min="0" max="0" value="0" aria-label="Scroll date window">
</main>
<script>
const data=${data};
const visible=${visibleCount};
const slider=document.getElementById('offset');
const bars=document.getElementById('bars');
const labels=document.getElementById('labels');
const chart=document.getElementById('chart');
const plot={x:60,y:20,width:920,height:400,min:60,max:180};
function draw(){
  const start=Number(slider.value), shown=data.slice(start,start+visible);
  const step=plot.width/Math.max(shown.length,1), scale=plot.height/(plot.max-plot.min);
  bars.replaceChildren(); labels.replaceChildren();
  for(let i=0;i<shown.length;i++){
    const item=shown[i], x=plot.x+i*step+step*.2, width=Math.max(2,step*.6);
    const top=plot.y+(plot.max-item.systolic)*scale, bottom=plot.y+(plot.max-item.diastolic)*scale;
    const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
    rect.setAttribute('x',String(x));rect.setAttribute('y',String(top));
    rect.setAttribute('width',String(width));rect.setAttribute('height',String(Math.max(1,bottom-top)));
    rect.setAttribute('class','bar');rect.setAttribute('aria-label',item.date+': '+Math.round(item.systolic)+'/'+Math.round(item.diastolic));
    bars.append(rect);
    if(i%Math.max(1,Math.floor(shown.length/8))===0){
      const text=document.createElementNS('http://www.w3.org/2000/svg','text');
      text.setAttribute('x',String(x));text.setAttribute('y','445');text.setAttribute('class','label');
      text.textContent=item.date;labels.append(text);
    }
  }
  const base=data[start];
  chart.setAttribute('aria-label',base?'Blood pressure measurements from '+base.date:'Blood pressure chart');
}
slider.max=String(Math.max(0,data.length-visible));
slider.value=slider.max;
slider.addEventListener('input',draw);draw();
</script></body></html>`;
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}
