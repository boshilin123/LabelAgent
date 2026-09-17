import React, { type ReactNode } from 'react';

function createStub(tag: string) {
  return React.forwardRef<
    HTMLElement,
    React.HTMLAttributes<HTMLElement> & Record<string, unknown>
  >(({ children, ...rest }, ref) =>
    React.createElement(tag, { ...rest, ref }, children as ReactNode),
  );
}

export const VscodeBadge = createStub('vscode-badge');
export const VscodeButton = createStub('vscode-button');
export const VscodeButtonGroup = createStub('vscode-button-group');
export const VscodeCheckbox = createStub('vscode-checkbox');
export const VscodeCheckboxGroup = createStub('vscode-checkbox-group');
export const VscodeCollapsible = createStub('vscode-collapsible');
export const VscodeContextMenu = createStub('vscode-context-menu');
export const VscodeContextMenuItem = createStub('vscode-context-menu-item');
export const VscodeDivider = createStub('vscode-divider');
export const VscodeFormContainer = createStub('vscode-form-container');
export const VscodeFormGroup = createStub('vscode-form-group');
export const VscodeFormHelper = createStub('vscode-form-helper');
export const VscodeIcon = createStub('vscode-icon');
export const VscodeLabel = createStub('vscode-label');
export const VscodeMultiSelect = createStub('vscode-multi-select');
export const VscodeOption = createStub('vscode-option');
export const VscodeProgressBar = createStub('vscode-progress-bar');
export const VscodeProgressRing = createStub('vscode-progress-ring');
export const VscodeRadio = createStub('vscode-radio');
export const VscodeRadioGroup = createStub('vscode-radio-group');
export const VscodeScrollable = createStub('vscode-scrollable');
export const VscodeSingleSelect = createStub('vscode-single-select');
export const VscodeSplitLayout = createStub('vscode-split-layout');
export const VscodeTabHeader = createStub('vscode-tab-header');
export const VscodeTabPanel = createStub('vscode-tab-panel');
export const VscodeTable = createStub('vscode-table');
export const VscodeTableBody = createStub('vscode-table-body');
export const VscodeTableCell = createStub('vscode-table-cell');
export const VscodeTableHeader = createStub('vscode-table-header');
export const VscodeTableHeaderCell = createStub('vscode-table-header-cell');
export const VscodeTableRow = createStub('vscode-table-row');
export const VscodeTabs = createStub('vscode-tabs');
export const VscodeTextarea = createStub('vscode-textarea');
export const VscodeTextfield = createStub('vscode-textfield');
export const VscodeToolbarButton = createStub('vscode-toolbar-button');
export const VscodeToolbarContainer = createStub('vscode-toolbar-container');
export const VscodeTree = createStub('vscode-tree');
export const VscodeTreeItem = createStub('vscode-tree-item');
