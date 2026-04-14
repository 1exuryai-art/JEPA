const express = require('express');

const app = express();
const PORT = 3000;

app.get('/oauth2callback', (req, res) => {
  const code = req.query.code;

  console.log('Authorization code:', code);

  res.send(`
    <html>
      <body style="font-family: Arial; padding: 40px;">
        <h2>Успешно</h2>
        <p>Код авторизации получен:</p>
        <textarea rows="8" cols="100">${code || 'code not found'}</textarea>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`OAuth server started: http://localhost:${PORT}`);
});
