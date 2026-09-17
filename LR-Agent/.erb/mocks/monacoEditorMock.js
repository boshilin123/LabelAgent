const models = new Map();

class TextModel {
  constructor(value, language, uri) {
    this.value = value;
    this.language = language;
    this.uri = uri ?? { path: '' };
  }

  getValue() {
    return this.value;
  }

  setValue(next) {
    this.value = next;
  }

  dispose() {
    models.delete(this.uri.path);
  }
}

module.exports = {
  Uri: {
    file: (filePath) => ({ path: filePath }),
    parse: (value) => ({ path: value }),
  },
  editor: {
    getModel: (uri) => {
      const data = models.get(uri?.path);
      if (!data) return null;
      return new TextModel(data.value, data.language, uri);
    },
    createModel: (value, language, uri) => {
      const key = uri?.path ?? '';
      models.set(key, { value, language });
      return new TextModel(value, language, uri ?? { path: key });
    },
    setModelLanguage: jest.fn(),
  },
};
