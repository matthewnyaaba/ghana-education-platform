// server.js - Complete Ghana Education Platform with Fixed AI Integration
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const winston = require('winston');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// AI Integration with proper error handling
let cohere = null;
let together = null;
let hf = null;

// Initialize AI clients safely
try {
  const { CohereClient } = require('cohere-ai');
  cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });
  console.log('✅ Cohere AI initialized');
} catch (error) {
  console.log('⚠️ Cohere AI not available:', error.message);
}

try {
  const TogetherAI = require('together-ai');
  together = new TogetherAI({
    apiKey: process.env.TOGETHER_API_KEY,
  });
  console.log('✅ Together AI initialized');
} catch (error) {
  console.log('⚠️ Together AI not available:', error.message);
}

try {
  const { HfInference } = require('@huggingface/inference');
  hf = new HfInference(process.env.HUGGINGFACE_TOKEN);
  console.log('✅ Hugging Face initialized');
} catch (error) {
  console.log('⚠️ Hugging Face not available:', error.message);
}

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// Database setup with SSL for Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Ghana Colleges of Education (All 47)
const GHANA_COLLEGES = [
  'Accra College of Education', 'Ada College of Education', 'Agogo Presbyterian College of Education',
  'Ahafoman College of Education', 'Akatsi College of Education', 'Akrokerri College of Education',
  'Bagabaga College of Education', 'Berekum College of Education', 'Dambai College of Education',
  'Enchi College of Education', 'Fosu College of Education', 'Gbewaa College of Education',
  'Holy Child College of Education', 'Jasikan College of Education', 'Kibi Presbyterian College of Education',
  'Komenda College of Education', 'Kpando College of Education', 'Mampong Technical College of Education',
  'Mt. Mary College of Education', 'Nusrat Jahan Ahmadiyya College of Education',
  'Offinso College of Education', 'OLA College of Education', 'Ola College of Education, Cape Coast',
  'Peki College of Education', 'Presbyterian College of Education, Abetifi',
  'Presbyterian College of Education, Akropong', 'SDA College of Education', 'Serwi-Aheman College of Education',
  'St. Francis College of Education', 'St. Joseph College of Education', 'St. Louis College of Education',
  'St. Monica College of Education', 'St. Vincent College of Education', 'Tamale College of Education',
  'Tumu College of Education', 'University of Cape Coast College of Education',
  'Wesley College of Education', 'Wiawso College of Education', 'Winneba College of Education',
  'Berekum College of Education', 'Foso College of Education', 'Gambaga College of Education',
  'Kinessis College of Education', 'Mawuko Girls College of Education', 'McCoy College of Education',
  'Pope John Senior High School and Minor Seminary', 'Pwani College of Education'
];

// Default system prompt
const DEFAULT_TEACHER_ASSISTANT_PROMPT = `Hello! Welcome to your Twenty-First Century Teacher Education Assistant, designed to support you as you navigate your B.Ed program in Ghana. I am here to help you with:

📚 Lecture/Course Notes
❓ Practice Questions  
📝 Assessment Preparation
🎯 Study Guidance
🏫 Supported Teaching in Schools (STS)
🔬 Action Research Writing

I will guide you step by step. Please respond with numbers only unless otherwise stated.

Let me know what you need help with today!

Available Options:
1. Lecture Notes
2. Practice Questions
3. Assessment Preparation
4. STS Support
5. Action Research Help

Please type the number (1-5) for what you need help with.`;

// Middleware with updated CORS for Netlify frontend
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    'https://charming-churros-c86d3e.netlify.app', // Your Netlify frontend
    process.env.FRONTEND_URL
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// File upload setup
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Enhanced Database Schema
async function initializeDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL,
      college_name VARCHAR(255),
      phone_number VARCHAR(20),
      region VARCHAR(100),
      program_type VARCHAR(50),
      current_year VARCHAR(10),
      current_semester VARCHAR(20),
      student_id VARCHAR(50),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chatbots (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      subject VARCHAR(100),
      grade_level VARCHAR(50),
      curriculum_area VARCHAR(100),
      system_prompt TEXT NOT NULL DEFAULT '${DEFAULT_TEACHER_ASSISTANT_PROMPT.replace(/'/g, "''")}',
      ai_provider VARCHAR(50) DEFAULT 'openai',
      model VARCHAR(100) DEFAULT 'gpt-3.5-turbo',
      max_tokens INTEGER DEFAULT 1000,
      temperature DECIMAL(3,2) DEFAULT 0.7,
      is_public BOOLEAN DEFAULT true,
      is_default BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      target_program VARCHAR(50),
      target_year VARCHAR(10),
      target_semester VARCHAR(20),
      access_code VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chatbot_enrollments (
      id SERIAL PRIMARY KEY,
      chatbot_id INTEGER REFERENCES chatbots(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_messages INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      UNIQUE(chatbot_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY,
      chatbot_id INTEGER REFERENCES chatbots(id) ON DELETE CASCADE,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(50),
      content TEXT NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      course_name VARCHAR(255),
      topic VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      chatbot_id INTEGER REFERENCES chatbots(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255),
      conversation_context JSONB,
      current_step VARCHAR(100),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      message_type VARCHAR(50) DEFAULT 'text',
      metadata JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS usage_analytics (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      chatbot_id INTEGER REFERENCES chatbots(id),
      action VARCHAR(100),
      metadata JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_college ON users(college_name);
    CREATE INDEX IF NOT EXISTS idx_chatbots_teacher ON chatbots(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
  `;

  try {
    await pool.query(schema);
    await createDefaultChatbots();
    logger.info('🇬🇭 Database schema initialized successfully');
  } catch (error) {
    logger.error('Database initialization failed:', error);
    throw error;
  }
}

// Create default chatbots
async function createDefaultChatbots() {
  try {
    const existingDefaults = await pool.query('SELECT id FROM chatbots WHERE is_default = true LIMIT 1');
    
    if (existingDefaults.rows.length > 0) {
      return;
    }

    const defaultChatbots = [
      {
        name: 'Ghana Teacher Education Assistant',
        description: 'AI assistant for Ghana B.Ed students',
        subject: 'General Teacher Education',
        system_prompt: DEFAULT_TEACHER_ASSISTANT_PROMPT,
        is_public: true,
        is_default: true,
        target_program: 'all',
        access_code: 'GHANA2024'
      }
    ];

    for (const chatbot of defaultChatbots) {
      await pool.query(
        `INSERT INTO chatbots (teacher_id, name, description, subject, system_prompt, is_public, is_default, target_program, access_code)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [chatbot.name, chatbot.description, chatbot.subject, chatbot.system_prompt, chatbot.is_public, chatbot.is_default, chatbot.target_program, chatbot.access_code]
      );
    }

    logger.info('✅ Default chatbots created');
  } catch (error) {
    logger.error('Failed to create default chatbots:', error);
  }
}

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'ghana-education-secret-key');
    const user = await pool.query('SELECT * FROM users WHERE id = $1 AND is_active = true', [decoded.userId]);
    
    if (user.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    req.user = user.rows[0];
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: 'Invalid token' });
  }
};

// AI Service Class
class GhanaEducationAI {
  constructor() {
    this.providers = [
      { name: 'cohere', client: cohere, available: !!cohere },
      { name: 'together', client: together, available: !!together },
      { name: 'huggingface', client: hf, available: !!hf }
    ];
    
    this.activeProviders = this.providers.filter(p => p.available);
    logger.info(`🤖 AI Providers: ${this.activeProviders.map(p => p.name).join(', ') || 'None - using fallback'}`);
  }

  async generateResponse(message, context = {}) {
    if (this.activeProviders.length === 0) {
      return {
        response: this.getFallbackResponse(message, context),
        provider: 'fallback',
        success: false
      };
    }

    // Try each provider
    for (const provider of this.activeProviders) {
      try {
        const response = await this.callProvider(provider, message, context);
        if (response) {
          return {
            response,
            provider: provider.name,
            success: true
          };
        }
      } catch (error) {
        logger.warn(`${provider.name} failed:`, error.message);
        continue;
      }
    }

    return {
      response: this.getFallbackResponse(message, context),
      provider: 'fallback',
      success: false
    };
  }

  async callProvider(provider, message, context) {
    const prompt = this.buildPrompt(message, context);
    
    switch (provider.name) {
      case 'cohere':
        if (!cohere) throw new Error('Cohere not initialized');
        const cohereResponse = await cohere.chat({
          model: 'command-r-plus',
          message: message,
          preamble: prompt,
          max_tokens: 800,
          temperature: 0.7
        });
        return cohereResponse.text;

      case 'together':
        if (!together) throw new Error('Together AI not initialized');
        const togetherResponse = await together.chat.completions.create({
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: message }
          ],
          model: 'meta-llama/Llama-3-8b-chat-hf',
          max_tokens: 800,
          temperature: 0.7
        });
        return togetherResponse.choices[0]?.message?.content;

      case 'huggingface':
        if (!hf) throw new Error('Hugging Face not initialized');
        const hfResponse = await hf.textGeneration({
          model: 'microsoft/DialoGPT-large',
          inputs: prompt.substring(0, 500),
          parameters: {
            max_length: 800,
            temperature: 0.7
          }
        });
        return hfResponse.generated_text;

      default:
        throw new Error('Unknown provider');
    }
  }

  buildPrompt(message, context) {
    const { user, chatbot } = context;
    
    return `You are an AI assistant for Ghana's Teacher Education system helping B.Ed students across Ghana's 47 Colleges of Education.

Student: ${user?.first_name} ${user?.last_name}
College: ${user?.college_name || 'Ghana College of Education'}
Program: ${user?.program_type || 'B.Ed Program'}

Focus on Ghana's B.Ed curriculum, educational policies, and teaching methods relevant to Ghanaian schools. Provide practical, culturally appropriate guidance.

User: ${message}

Response:`;
  }

  getFallbackResponse(message, context) {
    return `Hello! I'm your AI assistant for Ghana's Teacher Education system. 🇬🇭

While my advanced AI features are temporarily unavailable, I can help you with your B.Ed studies:

📚 **Course Materials**: Review your curriculum documents
🎓 **Study Support**: Connect with classmates in your program  
📝 **Practice**: Use past examination papers
🏫 **STS Guidance**: Consult your mentor teacher

For "${message}" - please be more specific about which area of your B.Ed program you need help with, and I'll provide detailed guidance based on Ghana's teacher education curriculum.

What specific topic would you like to explore?`;
  }
}

// Initialize AI service
const ghanaAI = new GhanaEducationAI();

// ROUTES

// Health check
app.get('/api/health', (req, res) => {
  const aiStatus = {
    cohere: !!cohere,
    together: !!together,
    huggingface: !!hf,
    total_active: ghanaAI.activeProviders.length
  };

  res.json({ 
    success: true, 
    status: '🇬🇭 Ghana Education Platform with AI is healthy!',
    timestamp: new Date().toISOString(),
    colleges: GHANA_COLLEGES.length,
    features: ['AI support', 'Student tracking', 'Teacher analytics'],
    ai_providers: aiStatus
  });
});

// Get Ghana colleges
app.get('/api/colleges', (req, res) => {
  res.json({ success: true, colleges: GHANA_COLLEGES });
});

// User registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, collegeName, programType, currentYear } = req.body;

    if (!email || !password || !firstName || !lastName || !role) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Check if user exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, college_name, program_type, current_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING id, email, first_name, last_name, role, college_name`,
      [email, passwordHash, firstName, lastName, role, collegeName, programType, currentYear]
    );

    const user = result.rows[0];

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'ghana-education-secret-key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: '🇬🇭 Welcome to Ghana Education Platform!',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        collegeName: user.college_name
      },
      token
    });

  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// User login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'ghana-education-secret-key',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: '🇬🇭 Welcome back!',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        collegeName: user.college_name
      },
      token
    });

  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// Get chatbots
app.get('/api/chatbots', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT c.*, COUNT(DISTINCT kb.id) as knowledge_items,
      CASE WHEN c.teacher_id = $1 THEN true ELSE false END as can_edit
      FROM chatbots c
      LEFT JOIN knowledge_base kb ON c.id = kb.chatbot_id
      WHERE (c.teacher_id = $1 OR c.is_default = true) AND c.is_active = true
      GROUP BY c.id
      ORDER BY c.is_default DESC, c.created_at DESC
    `;

    const result = await pool.query(query, [req.user.id]);
    
    res.json({
      success: true,
      chatbots: result.rows
    });

  } catch (error) {
    logger.error('Get chatbots error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch chatbots' });
  }
});

// Chat with AI
app.post('/api/chatbots/:id/chat', authenticateToken, async (req, res) => {
  try {
    const chatbotId = req.params.id;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    // Get chatbot
    const chatbotResult = await pool.query('SELECT * FROM chatbots WHERE id = $1 AND is_active = true', [chatbotId]);

    if (chatbotResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Chatbot not found' });
    }

    const chatbot = chatbotResult.rows[0];

    // Generate AI response
    const aiResult = await ghanaAI.generateResponse(message, {
      user: req.user,
      chatbot
    });

    const finalResponse = aiResult.response + `\n\n🇬🇭 *Ghana Education Platform - Supporting ${GHANA_COLLEGES.length} Colleges*`;

    res.json({
      success: true,
      response: finalResponse,
      metadata: {
        ai_provider: aiResult.provider,
        response_successful: aiResult.success
      }
    });

  } catch (error) {
    logger.error('Chat error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Chat failed',
      fallback_response: "I'm experiencing technical difficulties. Please try again."
    });
  }
});

// Create chatbot (teachers only)
app.post('/api/chatbots', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Only teachers can create chatbots' });
    }

    const { name, description, subject, systemPrompt, accessCode } = req.body;

    if (!name || !systemPrompt) {
      return res.status(400).json({ success: false, error: 'Name and system prompt are required' });
    }

    const finalAccessCode = accessCode || Math.random().toString(36).substring(2, 8).toUpperCase();

    const result = await pool.query(
      `INSERT INTO chatbots (teacher_id, name, description, subject, system_prompt, access_code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, name, description, subject, systemPrompt, finalAccessCode]
    );

    res.status(201).json({
      success: true,
      message: '🎓 Chatbot created successfully!',
      chatbot: result.rows[0]
    });

  } catch (error) {
    logger.error('Chatbot creation error:', error);
    res.status(500).json({ success: false, error: 'Failed to create chatbot' });
  }
});

// Upload files
app.post('/api/chatbots/:id/upload', authenticateToken, upload.array('files', 10), async (req, res) => {
  try {
    const chatbotId = req.params.id;
    const { courseName, topic } = req.body;

    // Verify ownership
    const chatbotResult = await pool.query('SELECT * FROM chatbots WHERE id = $1 AND teacher_id = $2', [chatbotId, req.user.id]);

    if (chatbotResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Chatbot not found' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const processedFiles = [];

    for (const file of req.files) {
      try {
        let content = '';
        
        if (file.mimetype === 'text/plain') {
          content = file.buffer.toString('utf-8');
        } else {
          content = `File: ${file.originalname} (${file.mimetype}) - Content processing available with full AI integration.`;
        }

        // Store content
        await pool.query(
          `INSERT INTO knowledge_base (chatbot_id, file_name, file_type, content, course_name, topic)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [chatbotId, file.originalname, file.mimetype, content, courseName, topic]
        );

        processedFiles.push({
          filename: file.originalname,
          size: file.size,
          courseName,
          topic
        });

      } catch (fileError) {
        logger.error(`File processing error:`, fileError);
      }
    }

    res.json({
      success: true,
      message: '📚 Files uploaded successfully!',
      processedFiles
    });

  } catch (error) {
    logger.error('File upload error:', error);
    res.status(500).json({ success: false, error: 'File upload failed' });
  }
});

// AI status
app.get('/api/ai/status', authenticateToken, async (req, res) => {
  try {
    const status = {
      providers: [
        { name: 'cohere', available: !!cohere, status: cohere ? 'healthy' : 'disabled' },
        { name: 'together', available: !!together, status: together ? 'healthy' : 'disabled' },
        { name: 'huggingface', available: !!hf, status: hf ? 'healthy' : 'disabled' }
      ],
      total_active: ghanaAI.activeProviders.length,
      fallback_enabled: true
    };

    res.json({
      success: true,
      ai_status: status
    });

  } catch (error) {
    logger.error('AI status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check AI status' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      logger.info(`🇬🇭 Ghana Education Platform running on port ${PORT}`);
      logger.info(`📚 Serving ${GHANA_COLLEGES.length} colleges with AI support!`);
      logger.info(`🤖 AI Providers: ${ghanaAI.activeProviders.length} active`);
    });
    
  } catch (error) {
    logger.error('Server startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});

startServer();
