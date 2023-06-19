/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

//@OnlyCurrentDoc
/* eslint-disable no-useless-escape */

import { CONFIG, Status } from './config';
import { MultiLogger } from './helpers/logger';
import { SheetsService } from './helpers/sheets';
import { Util } from './helpers/util';
import { VertexHelper } from './helpers/vertex';

/**
 * This is required to avoid treeshaking this file.
 * As long as anything from a file is being used, the entire file
 * is being kept.
 */
export const app = null;

const ORIGINAL_TITLE_TEMPLATE_PROMPT_PART =
  'product attribute keys in original title:';
const CATEGORY_PROMPT_PART = 'product category:';
const TEMPLATE_PROMPT_PART = 'product attribute keys:';
const ATTRIBUTES_PROMPT_PART = 'product attribute values:';
const SEPARATOR = '|';
const WORD_MATCH_REGEX = /(\w|\s)*\w(?=")|\w+/g;

const [
  vertexAiGcpProjectId,
  vertexAiGcpProjectLocation,
  vertexAiLanguageModelId,
] = [
  getConfigSheetValue(CONFIG.userSettings.vertexAi.gcpProjectId),
  getConfigSheetValue(CONFIG.userSettings.vertexAi.gcpProjectLocation),
  getConfigSheetValue(CONFIG.userSettings.vertexAi.languageModelId),
];

/**
 * Handle 'onOpen' Sheets event to show menu.
 */
export function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FeedGen')
    .addItem('Launch', 'showSidebar')
    .addToUi();
}

/**
 * Initialises context triggering Apps Script auth if not already done.
 */
export function init() {
  SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(CONFIG.sheets.config.name)
    ?.getDataRange();
}

/**
 * Find first row index for cell matching conditions.
 *
 * @param {string} sheetName
 * @param {string} searchValues
 * @param {number} column
 * @param {number} offset
 * @param {boolean} negate
 * @returns {number}
 */
function findRowIndex(
  sheetName: string,
  searchValues: string[],
  column: number,
  offset = 0,
  negate = false
) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(`Sheet ${sheetName} not found`);
  }

  if (sheet.getLastRow() - offset + 1 === 0) {
    return 0;
  }

  const range = sheet?.getRange(
    offset,
    column,
    sheet.getLastRow() - offset + 1,
    1
  );

  if (!range) {
    throw new Error('Invalid range');
  }

  const data = range.getValues();

  const rowIndex = data.flat().findIndex(cell => {
    if (negate) {
      return !searchValues.includes(cell);
    } else {
      return searchValues.includes(cell);
    }
  });

  return rowIndex >= 0 ? rowIndex : -1;
}

/**
 * Open sidebar.
 */
export function showSidebar() {
  const html = HtmlService.createTemplateFromFile('static/index').evaluate();
  html.setTitle('FeedGen');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Sheets utility function to fetch JSON'd context from input feed for few shot examples.
 */
export function FEEDGEN_CREATE_JSON_CONTEXT_FOR_ITEM(itemId: string) {
  const inputSheet = SpreadsheetApp.getActive().getSheetByName(
    CONFIG.sheets.input.name
  );
  const itemIdColumnName = getConfigSheetValue(
    CONFIG.userSettings.feed.itemIdColumnName
  );

  if (!inputSheet) return;

  const [headers, ...rows] = inputSheet
    .getRange(1, 1, inputSheet.getLastRow(), inputSheet.getMaxColumns())
    .getValues();

  const itemIdIndex = headers.indexOf(itemIdColumnName);
  const selectedRow = rows.filter(row => row[itemIdIndex] === itemId)[0];
  const contextObject = Object.fromEntries(
    headers
      .filter((key: string) => key)
      .map((key: string, index: number) => [key, selectedRow[index]])
  );
  return JSON.stringify(contextObject);
}

/**
 * Get index of row to be generated next.
 *
 * @returns {number}
 */
export function getNextRowIndexToBeGenerated() {
  const index = findRowIndex(
    CONFIG.sheets.generated.name,
    [Status.SUCCESS],
    CONFIG.sheets.generated.cols.status + 1,
    CONFIG.sheets.generated.startRow + 1,
    true
  );

  if (index < 0) {
    const totalGeneratedRows = SheetsService.getInstance().getTotalRows(
      CONFIG.sheets.generated.name
    );

    if (typeof totalGeneratedRows === 'undefined') {
      throw new Error('Error reading generated rows');
    }

    return totalGeneratedRows - CONFIG.sheets.generated.startRow;
  }

  return index;
}

/**
 * Generate content for next row.
 *
 * @returns {number}
 */
export function generateNextRow() {
  const inputSheet = SpreadsheetApp.getActive().getSheetByName(
    CONFIG.sheets.input.name
  );
  const generatedSheet = SpreadsheetApp.getActive().getSheetByName(
    CONFIG.sheets.generated.name
  );

  if (!inputSheet || !generatedSheet) return;

  const rowIndex = getNextRowIndexToBeGenerated();

  if (rowIndex >= inputSheet.getLastRow() - CONFIG.sheets.input.startRow) {
    return -1;
  }
  MultiLogger.getInstance().log(`Generating for row ${rowIndex}`);

  const row = inputSheet
    .getRange(
      CONFIG.sheets.input.startRow + 1 + rowIndex,
      1,
      1,
      inputSheet.getLastColumn()
    )
    .getValues()[0];

  try {
    const inputHeaders = SheetsService.getInstance().getHeaders(inputSheet);
    const optimizedRow = optimizeRow(inputHeaders, row);

    SheetsService.getInstance().setValuesInDefinedRange(
      CONFIG.sheets.generated.name,
      CONFIG.sheets.generated.startRow + 1 + rowIndex,
      1,
      [optimizedRow]
    );

    MultiLogger.getInstance().log(Status.SUCCESS);
  } catch (e) {
    MultiLogger.getInstance().log(`Error: ${e}`);

    const failedRow = [];
    failedRow[
      CONFIG.sheets.generated.cols.status
    ] = `${Status.FAILED}. See log for more details.`;
    generatedSheet.appendRow(failedRow);
  }

  return rowIndex;
}

/**
 * Get total number of data rows in 'Input' Sheet.
 *
 * @returns {number}
 */
export function getTotalInputRows() {
  const totalRows = SheetsService.getInstance().getTotalRows(
    CONFIG.sheets.input.name
  );

  return typeof totalRows === 'undefined'
    ? 0
    : totalRows - CONFIG.sheets.input.startRow;
}

/**
 * Get total number of data rows in 'Generated' Sheet.
 *
 * @returns {number}
 */
export function getTotalGeneratedRows() {
  const totalRows = SheetsService.getInstance().getTotalRows(
    CONFIG.sheets.generated.name
  );

  return typeof totalRows === 'undefined'
    ? 0
    : totalRows - CONFIG.sheets.generated.startRow;
}

const getGenerationMetrics = (
  origTitle: string,
  genTitle: string,
  origAttributes: Set<string>,
  genAttributes: Set<string>,
  inputWords: Set<string>,
  gapAttributesAndValues: Record<string, string>,
  originalInput: { [k: string]: string }
): Record<string, string> => {
  const titleChanged = origTitle !== genTitle;
  const addedAttributes = Util.getSetDifference(genAttributes, origAttributes);
  const newWordsAdded = new Set<String>();
  const genTitleWords = genTitle.match(WORD_MATCH_REGEX);
  if (genTitleWords) {
    genTitleWords
      .filter(
        (genTitleWord: string) => !inputWords.has(genTitleWord.toLowerCase())
      )
      .forEach((newWord: string) => newWordsAdded.add(newWord));
  }

  const gapAttributesPresent = Object.keys(gapAttributesAndValues).filter(
    gapKey => gapKey in originalInput
  );
  const gapAttributesInvented = Object.keys(gapAttributesAndValues).filter(
    gapKey => !(gapKey in originalInput)
  );

  const totalScore =
    (Number(addedAttributes.length > 0) +
      Number(titleChanged) +
      Number(newWordsAdded.size === 0) +
      Number(gapAttributesPresent.length > 0) +
      Number(gapAttributesInvented.length > 0)) /
    5;
  return {
    totalScore: totalScore.toString(),
    titleChanged: titleChanged.toString(),
    addedAttributes: addedAttributes
      .map((attr: string) => `<${attr}>`)
      .join(' '),
    newWordsAdded: [...newWordsAdded].join(` ${SEPARATOR} `),
  };
};

function getConfigSheetValue(field: { row: number; col: number }) {
  return SheetsService.getInstance().getCellValue(
    CONFIG.sheets.config.name,
    field.row,
    field.col
  );
}

/**
 * Use Vertex AI to optimize row.
 *
 * @param {string[]} headers
 * @param {string[]} data
 * @returns {Array<string | boolean | number>}
 */
function optimizeRow(
  headers: string[],
  data: string[]
): Array<string | boolean | number> {
  const dataObj = Object.fromEntries(
    data.map((item, index) => [headers[index], item])
  );

  const itemId =
    dataObj[getConfigSheetValue(CONFIG.userSettings.feed.itemIdColumnName)];
  const origTitle =
    dataObj[getConfigSheetValue(CONFIG.userSettings.feed.titleColumnName)];
  const origDescription =
    dataObj[
      getConfigSheetValue(CONFIG.userSettings.feed.descriptionColumnName)
    ];

  const res = fetchTitleGenerationData(dataObj);

  const [origTemplateRow, genCategoryRow, genTemplateRow, genAttributesRow] =
    res.split('\n');

  const genCategory = genCategoryRow.replace(CATEGORY_PROMPT_PART, '').trim();

  const genAttributes = genTemplateRow
    .replace(TEMPLATE_PROMPT_PART, '')
    .split(SEPARATOR)
    .filter((x: string) => x)
    .map((x: string) => x.trim());

  const genTemplate = genAttributes
    .map((x: string) => `<${x.trim()}>`)
    .join(' ');

  const origAttributes = origTemplateRow
    .replace(ORIGINAL_TITLE_TEMPLATE_PROMPT_PART, '')
    .split(SEPARATOR)
    .filter((x: string) => x)
    .map((x: string) => x.trim());

  const origTemplate = origAttributes
    .map((x: string) => `<${x.trim()}>`)
    .join(' ');

  const genAttributeValues = genAttributesRow
    .replace(ATTRIBUTES_PROMPT_PART, '')
    .split(SEPARATOR)
    .filter((x: string) => x)
    .map((x: string) => x.trim());

  // Use generated data only when user provided data is not available
  const titleFeatures: string[] = [];
  const gapAttributesAndValues: Record<string, string> = {};

  genAttributes.forEach((attribute: string, index: number) => {
    if (
      !dataObj[attribute] && // matches gaps ({color: ""}) AND invented
      (!origAttributes.includes(attribute) ||
        // force include gaps even if in generated template for original title
        Object.keys(dataObj).includes(attribute))
    ) {
      gapAttributesAndValues[attribute] = genAttributeValues[index];
    }
    titleFeatures.push(dataObj[attribute] || genAttributeValues[index]);
  });

  const genTitle = titleFeatures.join(' ');
  const genDescription = fetchDescriptionGenerationData(dataObj, genTitle);

  const inputWords = new Set<string>();
  Object.values(dataObj).forEach((value: string) => {
    const match = new String(value).match(WORD_MATCH_REGEX);
    if (match) {
      match.forEach((word: string) => inputWords.add(word.toLowerCase()));
    }
  });

  const { totalScore, titleChanged, addedAttributes, newWordsAdded } =
    getGenerationMetrics(
      origTitle,
      genTitle,
      new Set(origAttributes),
      new Set(genAttributes),
      inputWords,
      gapAttributesAndValues,
      dataObj
    );

  return [
    false, // approval
    'Success', // status
    itemId,
    genTitle,
    genDescription,
    genCategory,
    totalScore,
    titleChanged,
    origTemplate,
    genTemplate,
    addedAttributes,
    newWordsAdded,
    Object.keys(gapAttributesAndValues).length > 0
      ? JSON.stringify(gapAttributesAndValues)
      : '',
    JSON.stringify(dataObj),
    origTitle,
    origDescription,
    `${res}\nproduct description: ${genDescription}`, // API response
  ];
}

function fetchTitleGenerationData(data: Record<string, unknown>): string {
  // Extra lines (\n) instruct LLM to comlpete what is missing. Don't remove.
  const dataContext = `Context: ${JSON.stringify(data)}\n\n`;
  const prompt =
    getConfigSheetValue(CONFIG.userSettings.title.fullPrompt) + dataContext;
  const res = Util.executeWithRetry(CONFIG.vertexAi.maxRetries, () =>
    VertexHelper.getInstance(
      vertexAiGcpProjectId,
      vertexAiGcpProjectLocation,
      vertexAiLanguageModelId,
      {
        temperature: Number(
          getConfigSheetValue(
            CONFIG.userSettings.title.modelParameters.temperature
          )
        ),
        maxOutputTokens: Number(
          getConfigSheetValue(
            CONFIG.userSettings.title.modelParameters.maxOutputTokens
          )
        ),
        topK: Number(
          getConfigSheetValue(CONFIG.userSettings.title.modelParameters.topK)
        ),
        topP: Number(
          getConfigSheetValue(CONFIG.userSettings.title.modelParameters.topP)
        ),
      }
    ).predict(prompt)
  );
  return res;
}

function fetchDescriptionGenerationData(
  data: Record<string, unknown>,
  generatedTitle: string
): string {
  // Extra lines (\n) instruct LLM to complete what is missing. Don't remove.
  const modifiedData = Object.assign(data, {
    'Generated Title': generatedTitle,
  });
  const dataContext = `Context: ${JSON.stringify(modifiedData)}\n\n`;
  const prompt =
    getConfigSheetValue(CONFIG.userSettings.description.fullPrompt) +
    dataContext;
  const res = Util.executeWithRetry(CONFIG.vertexAi.maxRetries, () =>
    VertexHelper.getInstance(
      vertexAiGcpProjectId,
      vertexAiGcpProjectLocation,
      vertexAiLanguageModelId,
      {
        temperature: Number(
          getConfigSheetValue(
            CONFIG.userSettings.description.modelParameters.temperature
          )
        ),
        maxOutputTokens: Number(
          getConfigSheetValue(
            CONFIG.userSettings.description.modelParameters.maxOutputTokens
          )
        ),
        topK: Number(
          getConfigSheetValue(
            CONFIG.userSettings.description.modelParameters.topK
          )
        ),
        topP: Number(
          getConfigSheetValue(
            CONFIG.userSettings.description.modelParameters.topP
          )
        ),
      }
    ).predict(prompt)
  );
  return res;
}

/**
 * Get rows from 'FeedGen' sheet.
 *
 * @returns {string[][]}
 */
function getGeneratedRows() {
  return SheetsService.getInstance().getRangeData(
    CONFIG.sheets.generated.name,
    CONFIG.sheets.generated.startRow + 1,
    1
  );
}

/**
 * Write data rows to 'FeedGen' sheet.
 */
function writeGeneratedRows(rows: string[][], withHeader = false) {
  const offset = withHeader ? 0 : 1;

  SheetsService.getInstance().setValuesInDefinedRange(
    CONFIG.sheets.generated.name,
    CONFIG.sheets.generated.startRow + offset,
    1,
    rows
  );
}

/**
 * Write rows to 'Approved' Sheet.
 *
 * @param {string[][]} rows
 */
function writeApprovedData(header: string[], rows: string[][]) {
  MultiLogger.getInstance().log('Writing approved data...');
  SheetsService.getInstance().setValuesInDefinedRange(
    CONFIG.sheets.output.name,
    CONFIG.sheets.output.startRow,
    CONFIG.sheets.output.cols.id.idx + 1,
    [header]
  );
  SheetsService.getInstance().setValuesInDefinedRange(
    CONFIG.sheets.output.name,
    CONFIG.sheets.output.startRow + 1,
    1,
    rows
  );
}

/**
 * Clear all data rows from 'Supplemental Feed' sheet.
 */
function clearApprovedData() {
  MultiLogger.getInstance().log('Clearing approved data...');
  SheetsService.getInstance().clearDefinedRange(
    CONFIG.sheets.output.name,
    CONFIG.sheets.output.startRow,
    CONFIG.sheets.output.cols.id.idx + 1
  );
  SheetsService.getInstance().clearDefinedRange(
    CONFIG.sheets.output.name,
    CONFIG.sheets.output.startRow + 1,
    1
  );
}

/**
 * Clear all data rows from 'Supplemental Feed' sheet.
 */
export function clearGeneratedRows() {
  MultiLogger.getInstance().log('Clearing generated rows...');
  MultiLogger.getInstance().clear();
  SheetsService.getInstance().clearDefinedRange(
    CONFIG.sheets.generated.name,
    CONFIG.sheets.generated.startRow + 1,
    1
  );
}

/**
 * Set status for title and descrition to 'Approved' for rows.
 * Depending on current status.
 */
export function approveFiltered() {
  MultiLogger.getInstance().log('Approving filtered rows...');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    CONFIG.sheets.generated.name
  );
  const rows = getGeneratedRows();

  if (!sheet || !rows) return;

  rows.map((row, index) => {
    row[CONFIG.sheets.generated.cols.approval] = sheet.isRowHiddenByFilter(
      index + CONFIG.sheets.generated.startRow + 1
    )
      ? row[CONFIG.sheets.generated.cols.approval]
      : true;

    return row;
  });
  writeGeneratedRows(rows);
  MultiLogger.getInstance().log('Writing approved rows...');
}

function getGapAndInventedAttributes(rows: string[][]) {
  const filledInGapAttributes = [
    ...new Set(
      rows
        .filter(row => row[CONFIG.sheets.generated.cols.gapAttributes])
        .map(row =>
          Object.keys(
            JSON.parse(row[CONFIG.sheets.generated.cols.gapAttributes])
          )
        )
        .flat(1)
    ),
  ];
  const allInputAttributes = [
    ...new Set(
      rows
        .filter(row => row[CONFIG.sheets.generated.cols.originalInput])
        .map(row =>
          Object.keys(
            JSON.parse(row[CONFIG.sheets.generated.cols.originalInput])
          )
        )
        .flat(1)
    ),
  ];

  const inventedAttributes = filledInGapAttributes.filter(
    gapKey => !allInputAttributes.includes(gapKey)
  );
  const gapAttributes = filledInGapAttributes.filter(
    gapKey => !inventedAttributes.includes(gapKey)
  );

  return [inventedAttributes, gapAttributes];
}

/**
 * Merge title and other attributes from 'FeedGen' to 'Approved' sheet.
 */
export function exportApproved() {
  MultiLogger.getInstance().log('Exporting approved rows...');

  const feedGenRows = getGeneratedRows().filter(
    row => row[CONFIG.sheets.generated.cols.approval] === true
  );

  if (feedGenRows.length === 0) return;

  const [inventedAttributes, gapAttributes] =
    getGapAndInventedAttributes(feedGenRows);

  const gapAndInventedAttributes = [...gapAttributes, ...inventedAttributes];

  const outputHeader: string[] = [
    CONFIG.sheets.output.cols.id.name,
    CONFIG.sheets.output.cols.title.name,
    CONFIG.sheets.output.cols.description.name,
    ...gapAttributes,
    ...inventedAttributes.map(key => `new_${key}`),
  ];

  const rowsToWrite: string[][] = [];
  for (const row of feedGenRows) {
    const resRow: string[] = [];

    resRow[CONFIG.sheets.output.cols.modificationTimestamp] =
      new Date().toISOString();
    resRow[CONFIG.sheets.output.cols.id.idx] =
      row[CONFIG.sheets.generated.cols.id];
    resRow[CONFIG.sheets.output.cols.title.idx] =
      row[CONFIG.sheets.generated.cols.titleGenerated];
    resRow[CONFIG.sheets.output.cols.description.idx] =
      row[CONFIG.sheets.generated.cols.descriptionGenerated];

    const gapAttributesAndValues = row[
      CONFIG.sheets.generated.cols.gapAttributes
    ]
      ? JSON.parse(row[CONFIG.sheets.generated.cols.gapAttributes])
      : {};
    const gapAttributesKeys = Object.keys(gapAttributesAndValues);
    const originalInput = row[CONFIG.sheets.generated.cols.originalInput]
      ? JSON.parse(row[CONFIG.sheets.generated.cols.originalInput])
      : {};

    gapAndInventedAttributes.forEach(
      (attribute, index) =>
        (resRow[CONFIG.sheets.output.cols.gapCols.start + index] =
          gapAttributesKeys.includes(attribute)
            ? gapAttributesAndValues[attribute]
            : originalInput[attribute])
    );

    rowsToWrite.push(resRow);
  }
  clearApprovedData();
  writeApprovedData(outputHeader, rowsToWrite);
}