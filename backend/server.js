require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/health',         require('./src/routes/health'));
app.use('/api/scrape-targets', require('./src/routes/scrapeTargets'));
app.use('/api/scrape',         require('./src/routes/scrape'));
app.use('/api/questions',      require('./src/routes/questions'));
app.use('/api/answers',        require('./src/routes/answers'));
app.use('/api/knowledge-base', require('./src/routes/knowledgeBase'));
app.use('/api/agents',         require('./src/routes/agents'));
app.use('/api/dashboard',      require('./src/routes/dashboard'));
app.use('/api/config',         require('./src/routes/config'));
app.use('/api/post-answers',   require('./src/routes/postAnswers'));

// Start scheduler
require('./src/services/scheduler');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CQM v2 backend running on port ${PORT}`));
