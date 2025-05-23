// Get available chatbots with enrollment info
app.get('/api/chatbots', authenticateToken, async (req, res) => {
  try {
    let query, params;

    if (req.user.role === 'teacher') {
      // Teachers see all chatbots they created + default ones + enrollment counts
      query = `
        SELECT c.*, 
        COUNT(DISTINCT kb.id) as knowledge_items,
        COUNT(DISTINCT ce.student_id) as enrolled_students,
        CASE WHEN c.teacher_id = $1 THEN true ELSE false END as can_edit
        FROM chatbots c
        LEFT JOIN knowledge_base kb ON c.id = kb.chatbot_id
        LEFT JOIN chatbot_enrollments ce ON c.id = ce.chatbot_id AND ce.is_active = true
        WHERE (c.teacher_id = $1 OR c.is_default = true) AND c.is_active = true
        GROUP BY c.id
        ORDER BY c.is_default DESC, c.created_at DESC
      `;
      params = [req.user.id];
    } else {
      // Students see chatbots they're enrolled in or can join
      query = `
        SELECT c.*, u.first_name, u.last_name, 
        COUNT(DISTINCT kb.id) as knowledge_items,
        COUNT(DISTINCT ce2.student_id) as enrolled_students,
        CASE WHEN ce1.student_id IS NOT NULL THEN true ELSE false END as is_enrolled,
        false as can_edit
        FROM chatbots c
        LEFT JOIN users u ON c.teacher_id = u.id
        LEFT JOIN knowledge_base kb ON c.id = kb.chatbot_id
        LEFT JOIN chatbot_enrollments ce1 ON c.id = ce1.chatbot_id AND ce1.student_id = $1 AND ce1.is_active = true
        LEFT JOIN chatbot_enrollments ce2 ON c.id = ce2.chatbot_id AND ce2.is_active = true
        WHERE c.is_active = true AND 
        (c.is_public = true OR c.is_default = true OR ce1.student_id IS NOT NULL) AND
        (c.target_program IN ('all', $2) OR c.target_program IS NULL)
        GROUP BY c.id, u.first_name, u.last_name, ce1.student_id
        ORDER BY is_enrolled DESC, c.is_default DESC, c.created_at DESC
      `;
      params = [req.user.id, req.user.program_type || 'all'];
    }

    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      chatbots: result.rows
    });

  } catch (error) {
    logger.error('Get chatbots error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch chatbots' });
  }
});

// Student enrollment in chatbot
app.post('/api/chatbots/:id/enroll', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ success: false, error: 'Only students can enroll in chatbots' });
    }

    const chatbotId = req.params.id;
    const { accessCode } = req.body;

    // Get chatbot details
    const chatbotResult = await pool.query(
      'SELECT * FROM chatbots WHERE id = $1 AND is_active = true',
      [chatbotId]
    );

    if (chatbotResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Chatbot not found' });
    }

    const chatbot = chatbotResult.rows[0];

    // Check access code if required
    if (chatbot.access_code && chatbot.access_code !== accessCode) {
      return res.status(401).json({ success: false, error: 'Invalid access code' });
    }

    // Enroll student
    await pool.query(
      `INSERT INTO chatbot_enrollments (chatbot_id, student_id) 
       VALUES ($1, $2) 
       ON CONFLICT (chatbot_id, student_id) 
       DO UPDATE SET is_active = true, enrolled_at = CURRENT_TIMESTAMP`,
      [chatbotId, req.user.id]
    );

    res.json({
      success: true,
      message: `Successfully enrolled in ${chatbot.name}!`
    });

  } catch (error) {
    logger.error('Enrollment error:', error);
    res.status(500).json({ success: false, error: 'Enrollment failed' });
  }
});

// Get students enrolled in teacher's chatbots
app.get('/api/teacher/students', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const query = `
      SELECT 
        c.id as chatbot_id,
        c.name as chatbot_name,
        u.id as student_id,
        u.first_name,
        u.last_name,
        u.email,
        u.college_name,
        u.program_type,
        u.current_year,
        u.current_semester,
        u.student_id as student_number,
        ce.enrolled_at,
        ce.last_active,
        ce.total_messages,
        COUNT(DISTINCT conv.id) as conversations_count,
        COUNT(DISTINCT m.id) as total_messages_sent
      FROM chatbots c
      JOIN chatbot_enrollments ce ON c.id = ce.chatbot_id
      JOIN users u ON ce.student_id = u.id
      LEFT JOIN conversations conv ON c.id = conv.chatbot_id AND conv.user_id = u.id
      LEFT JOIN messages m ON conv.id = m.conversation_id AND m.role = 'user'
      WHERE c.teacher_id = $1 AND ce.is_active = true AND u.is_active = true
      GROUP BY c.id, c.name, u.id, u.first_name, u.last_name, u.email, 
               u.college_name, u.program_type, u.current_year, u.current_semester, 
               u.student_id, ce.enrolled_at, ce.last_active, ce.total_messages
      ORDER BY c.name, u.last_name, u.first_name
    `;

    const result = await pool.query(query, [req.user.id]);

    // Group by chatbot
    const chatbotStudents = {};
    result.rows.forEach(row => {
      if (!chatbotStudents[row.chatbot_id]) {
        chatbotStudents[row.chatbot_id] = {
          chatbot_id: row.chatbot_id,
          chatbot_name: row.chatbot_name,
          students: [],
          total_students: 0
        };
      }
      
      chatbotStudents[row.chatbot_id].students.push({
        student_id: row.student_id,
        name: `${row.first_name} ${row.last_name}`,
        email: row.email,
        college: row.college_name,
        program: row.program_type,
        year: row.current_year,
        semester: row.current_semester,
        student_number: row.student_number,
        enrolled_at: row.enrolled_at,
        last_active: row.last_active,
        conversations: row.conversations_count,
        messages_sent: row.total_messages_sent
      });
      
      chatbotStudents[row.chatbot_id].total_students++;
    });

    res.json({
      success: true,
      chatbot_enrollments: Object.values(chatbotStudents)
    });

  } catch (error) {
    logger.error('Get students error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch students' });
  }
});

// Enhanced chat with AI integration
app.post('/api/chatbots/:id/chat', authenticateToken, async (req, res) => {
  try {
    const chatbotId = req.params.id;
    const { message, conversationId } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    // Check enrollment (existing code)
    if (req.user.role === 'student') {
      const enrollmentCheck = await pool.query(
        `SELECT ce.*, c.is_default FROM chatbot_enrollments ce 
         JOIN chatbots c ON ce.chatbot_id = c.id
         WHERE ce.chatbot_id = $1 AND ce.student_id = $2 AND ce.is_active = true`,
        [chatbotId, req.user.id]
      );

      const chatbotCheck = await pool.query('SELECT is_default FROM chatbots WHERE id = $1', [chatbotId]);
      
      if (enrollmentCheck.rows.length === 0 && chatbotCheck.rows[0]?.is_default !== true) {
        return res.status(403).json({ success: false, error: 'You must enroll in this chatbot first' });
      }

      // Update engagement tracking
      await pool.query(
        `UPDATE chatbot_enrollments 
         SET last_active = CURRENT_TIMESTAMP, total_messages = total_messages + 1
         WHERE chatbot_id = $1 AND student_id = $2`,
        [chatbotId, req.user.id]
      );
    }

    // Get chatbot details
    const chatbotResult = await pool.query(
      `SELECT c.*, u.first_name, u.last_name 
       FROM chatbots c 
       LEFT JOIN users u ON c.teacher_id = u.id 
       WHERE c.id = $1 AND c.is_active = true`,
      [chatbotId]
    );

    if (chatbotResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Chatbot not found' });
    }

    const chatbot = chatbotResult.rows[0];

    // Get or create conversation
    let conversation;
    if (conversationId) {
      const convResult = await pool.query(
        'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
        [conversationId, req.user.id]
      );
      conversation = convResult.rows[0];
    }

    if (!conversation) {
      const newConvResult = await pool.query(
        `INSERT INTO conversations (chatbot_id, user_id, title, conversation_context, current_step) 
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          chatbotId, 
          req.user.id, 
          message.substring(0, 50) + '...', 
          JSON.stringify({}),
          'greeting'
        ]
      );
      conversation = newConvResult.rows[0];
    }

    // Save user message
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [conversation.id, 'user', message]
    );

    // Get relevant knowledge base content using RAG
    const relevantKnowledge = await ghanaAI.getRelevantKnowledge(chatbotId, message);
    
    // Generate AI response using multi-provider system
    const aiResult = await ghanaAI.generateResponse(message, {
      user: req.user,
      chatbot,
      conversationContext: conversation.conversation_context
    }, relevantKnowledge);

    let finalResponse = aiResult.response;

    // Add curriculum context if available
    if (relevantKnowledge.length > 0) {
      finalResponse += `\n\n📚 **Related Curriculum Content:**\n`;
      relevantKnowledge.forEach(kb => {
        finalResponse += `• **${kb.course_name}**: ${kb.content.substring(0, 150)}...\n`;
      });
    }

    // Add Ghana-specific footer
    finalResponse += `\n\n🇬🇭 *Powered by Ghana Education Platform - Supporting ${GHANA_COLLEGES.length} Colleges of Education*`;

    // Save AI response with metadata
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
      [
        conversation.id, 
        'assistant', 
        finalResponse,
        JSON.stringify({ 
          ai_provider: aiResult.provider,
          success: aiResult.success,
          knowledge_items_used: relevantKnowledge.length
        })
      ]
    );

    // Update conversation context
    await pool.query(
      'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conversation.id]
    );

    // Log analytics
    await pool.query(
      'INSERT INTO usage_analytics (user_id, chatbot_id, action, metadata) VALUES ($1, $2, $3, $4)',
      [req.user.id, chatbotId, 'ai_message_sent', JSON.stringify({ 
        ai_provider: aiResult.provider,
        message_length: message.length,
        knowledge_items: relevantKnowledge.length
      })]
    );

    res.json({
      success: true,
      response: finalResponse,
      conversationId: conversation.id,
      metadata: {
        ai_provider: aiResult.provider,
        knowledge_items_used: relevantKnowledge.length,
        response_successful: aiResult.success
      }
    });

  } catch (error) {
    logger.error('Enhanced chat error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Chat failed',
      fallback_response: "I'm experiencing technical difficulties. Please try again or contact your teacher for assistance."
    });
  }
});

// Create/customize chatbot (teachers only)
app.post('/api/chatbots', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Only teachers can create chatbots' });
    }

    const {
      name, description, subject, gradeLevel, curriculumArea,
      systemPrompt, isPublic = false, targetProgram, targetYear, targetSemester, accessCode
    } = req.body;

    if (!name || !systemPrompt) {
      return res.status(400).json({ success: false, error: 'Name and system prompt are required' });
    }

    // Generate access code if not provided
    const finalAccessCode = accessCode || Math.random().toString(36).substring(2, 8).toUpperCase();

    const result = await pool.query(
      `INSERT INTO chatbots (teacher_id, name, description, subject, grade_level, curriculum_area, 
                            system_prompt, is_public, target_program, target_year, target_semester, access_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
       RETURNING *`,
      [req.user.id, name, description, subject, gradeLevel, curriculumArea, 
       systemPrompt, isPublic, targetProgram, targetYear, targetSemester, finalAccessCode]
    );

    const chatbot = result.rows[0];

    res.status(201).json({
      success: true,
      message: '🎓 AI-powered chatbot created successfully!',
      chatbot,
      accessCode: finalAccessCode
    });

  } catch (error) {
    logger.error('Chatbot creation error:', error);
    res.status(500).json({ success: false, error: 'Failed to create chatbot' });
  }
});

// Upload curriculum materials (teachers only)
app.post('/api/chatbots/:id/upload', authenticateToken, upload.array('files', 10), async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Only teachers can upload materials' });
    }

    const chatbotId = req.params.id;
    const { courseName, topic } = req.body;

    // Verify ownership
    const chatbotResult = await pool.query(
      'SELECT * FROM chatbots WHERE id = $1 AND teacher_id = $2',
      [chatbotId, req.user.id]
    );

    if (chatbotResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Chatbot not found or access denied' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const processedFiles = [];

    for (const file of req.files) {
      try {
        // Extract text from file
        const content = await extractTextFromFile(file);
        const chunks = chunkText(content);

        // Store each chunk with course and topic information
        for (let i = 0; i < chunks.length; i++) {
          await pool.query(
            `INSERT INTO knowledge_base (chatbot_id, file_name, file_type, content, chunk_index, course_name, topic)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [chatbotId, file.originalname, file.mimetype, chunks[i], i, courseName, topic]
          );
        }

        processedFiles.push({
          filename: file.originalname,
          chunks: chunks.length,
          size: file.size,
          courseName,
          topic
        });

      } catch (fileError) {
        logger.error(`File processing error for ${file.originalname}:`, fileError);
        processedFiles.push({
          filename: file.originalname,
          error: fileError.message
        });
      }
    }

    res.json({
      success: true,
      message: '📚 Curriculum materials uploaded and processed for AI!',
      processedFiles
    });

  } catch (error) {
    logger.error('File upload error:', error);
    res.status(500).json({ success: false, error: 'File upload failed' });
  }
});

// File processing functions
async function extractTextFromFile(file) {
  try {
    switch (file.mimetype) {
      case 'application/pdf':
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(file.buffer);
        return pdfData.text;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const mammoth = require('mammoth');
        const docxData = await mammoth.extractRawText({ buffer: file.buffer });
        return docxData.value;
      case 'text/plain':
        return file.buffer.toString('utf-8');
      default:
        throw new Error('Unsupported file type');
    }
  } catch (error) {
    logger.error('File extraction error:', error);
    throw error;
  }
}

function chunkText(text, chunkSize = 1000) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + chunkSize;
    if (end > text.length) end = text.length;
    
    // Try to end at sentence boundary
    if (end < text.length) {
      const lastSentence = text.lastIndexOf('.', end);
      if (lastSentence > start + chunkSize * 0.5) {
        end = lastSentence + 1;
      }
    }
    
    chunks.push(text.slice(start, end).trim());
    start = end - 200; // 200 char overlap
    
    if (start >= text.length) break;
  }
  
  return chunks;
}

// Add AI status endpoint
app.get('/api/ai/status', authenticateToken, async (req, res) => {
  try {
    const status = {
      providers: [
        { name: 'cohere', available: !!cohere, status: 'unknown' },
        { name: 'together', available: !!together, status: 'unknown' },
        { name: 'huggingface', available: !!hf, status: 'unknown' }
      ],
      total_active: ghanaAI.activeProviders.length,
      fallback_enabled: true
    };

    // Test each provider quickly
    for (let i = 0; i < status.providers.length; i++) {
      const provider = status.providers[i];
      if (!provider.available) {
        provider.status = 'disabled';
        continue;
      }

      try {
        // Quick test based on provider
        let testResult = false;
        switch (provider.name) {
          case 'cohere':
            if (cohere && process.env.COHERE_API_KEY) {
              testResult = true; // Simple availability check
            }
            break;
          case 'together':
            if (together && process.env.TOGETHER_API_KEY) {
              testResult = true;
            }
            break;
          case 'huggingface':
            if (hf && process.env.HUGGINGFACE_TOKEN) {
              testResult = true;
            }
            break;
        }
        
        provider.status = testResult ? 'healthy' : 'error';
      } catch (error) {
        provider.status = 'error';
        provider.error = error.message;
      }
    }

    res.json({
      success: true,
      ai_status: status
    });

  } catch (error) {
    logger.error('AI status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check AI status' });
  }
});

// Get detailed teacher analytics with student info
app.get('/api/teacher/analytics', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Get comprehensive analytics
    const analyticsQuery = `
      SELECT 
        c.id as chatbot_id,
        c.name as chatbot_name,
        c.access_code,
        COUNT(DISTINCT ce.student_id) as total_students,
        COUNT(DISTINCT CASE WHEN ce.last_active >= NOW() - INTERVAL '30 days' THEN ce.student_id END) as active_students_30d,
        COUNT(DISTINCT CASE WHEN ce.last_active >= NOW() - INTERVAL '7 days' THEN ce.student_id END) as active_students_7d,
        COUNT(DISTINCT conv.id) as total_conversations,
        COUNT(m.id) as total_messages,
        AVG(ce.total_messages) as avg_messages_per_student,
        COUNT(DISTINCT kb.id) as knowledge_items,
        c.created_at
      FROM chatbots c
      LEFT JOIN chatbot_enrollments ce ON c.id = ce.chatbot_id AND ce.is_active = true
      LEFT JOIN conversations conv ON c.id = conv.chatbot_id
      LEFT JOIN messages m ON conv.id = m.conversation_id AND m.role = 'user'
      LEFT JOIN knowledge_base kb ON c.id = kb.chatbot_id
      WHERE c.teacher_id = $1
      GROUP BY c.id, c.name, c.access_code, c.created_at
      ORDER BY total_students DESC, c.created_at DESC
    `;

    const analyticsResult = await pool.query(analyticsQuery, [req.user.id]);

    // Get college distribution
    const collegeQuery = `
      SELECT 
        u.college_name,
        COUNT(DISTINCT ce.student_id) as student_count
      FROM chatbots c
      JOIN chatbot_enrollments ce ON c.id = ce.chatbot_id AND ce.is_active = true
      JOIN users u ON ce.student_id = u.id
      WHERE c.teacher_id = $1
      GROUP BY u.college_name
      ORDER BY student_count DESC
    `;

    const collegeResult = await pool.query(collegeQuery, [req.user.id]);

    // Get program distribution
    const programQuery = `
      SELECT 
        u.program_type,
        u.current_year,
        COUNT(DISTINCT ce.student_id) as student_count
      FROM chatbots c
      JOIN chatbot_enrollments ce ON c.id = ce.chatbot_id AND ce.is_active = true
      JOIN users u ON ce.student_id = u.id
      WHERE c.teacher_id = $1
      GROUP BY u.program_type, u.current_year
      ORDER BY student_count DESC
    `;

    const programResult = await pool.query(programQuery, [req.user.id]);

    res.json({
      success: true,
      analytics: {
        chatbot_stats: analyticsResult.rows,
        college_distribution: collegeResult.rows,
        program_distribution: programResult.rows,
        summary: {
          total_chatbots: analyticsResult.rows.length,
          total_students: analyticsResult.rows.reduce((sum, row) => sum + parseInt(row.total_students), 0),
          total_messages: analyticsResult.rows.reduce((sum, row) => sum + parseInt(row.total_messages), 0),
          active_colleges: collegeResult.rows.length
        }
      }
    });

  } catch (error) {
    logger.error('Analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// Get conversation history
app.get('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const conversationId = req.params.id;

    // Verify conversation ownership or teacher access
    let authQuery;
    if (req.user.role === 'teacher') {
      authQuery = `
        SELECT conv.* FROM conversations conv
        JOIN chatbots c ON conv.chatbot_id = c.id
        WHERE conv.id = $1 AND (conv.user_id = $2 OR c.teacher_id = $2)
      `;
    } else {
      authQuery = 'SELECT * FROM conversations WHERE id = $1 AND user_id = $2';
    }

    const convResult = await pool.query(authQuery, [conversationId, req.user.id]);

    if (convResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    // Get messages
    const messagesResult = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );

    res.json({
      success: true,
      conversation: convResult.rows[0],
      messages: messagesResult.rows
    });

  } catch (error) {
    logger.error('Get messages error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

// Search students across teacher's chatbots
app.get('/api/teacher/students/search', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const { q, college, program, year } = req.query;

    let query = `
      SELECT DISTINCT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.college_name,
        u.program_type,
        u.current_year,
        u.current_semester,
        u.student_id,
        COUNT(DISTINCT ce.chatbot_id) as enrolled_chatbots,
        MAX(ce.last_active) as last_active
      FROM users u
      JOIN chatbot_enrollments ce ON u.id = ce.student_id
      JOIN chatbots c ON ce.chatbot_id = c.id
      WHERE c.teacher_id = $1 AND ce.is_active = true AND u.is_active = true
    `;

    const params = [req.user.id];
    let paramCount = 1;

    if (q) {
      paramCount++;
      query += ` AND (u.first_name ILIKE ${paramCount} OR u.last_name ILIKE ${paramCount} OR u.email ILIKE ${paramCount})`;
      params.push(`%${q}%`);
    }

    if (college) {
      paramCount++;
      query += ` AND u.college_name ILIKE ${paramCount}`;
      params.push(`%${college}%`);
    }

    if (program) {
      paramCount++;
      query += ` AND u.program_type = ${paramCount}`;
      params.push(program);
    }

    if (year) {
      paramCount++;
      query += ` AND u.current_year = ${paramCount}`;
      params.push(year);
    }

    query += ` GROUP BY u.id ORDER BY u.last_name, u.first_name LIMIT 50`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      students: result.rows
    });

  } catch (error) {
    logger.error('Student search error:', error);
    res.status(500).json({ success: false, error: 'Student search failed' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'File too large (max 10MB)' });
    }
  }
  
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
      logger.info(`🇬🇭 Ghana Education Platform with Multi-AI Integration running on port ${PORT}`);
      logger.info(`📚 Ready to serve ${GHANA_COLLEGES.length} colleges with AI-powered education!`);
      logger.info(`🤖 AI Providers: ${ghanaAI.activeProviders.length} active`);
      logger.info(`🎓 Features: Multi-AI, Student tracking, RAG, Teacher analytics`);
      logger.info(`🚀 Visit: ${process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`}/api/health`);
    });
    
  } catch (error) {
    logger.error('Server startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await pool.end();// server.js - Complete Ghana Education Platform with Fixed Multi-AI Integration
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

// B.Ed Curriculum Structure
const CURRICULUM_STRUCTURE = {
  programs: {
    'early_grade': 'Early Grade (Kindergarten - Primary 3)',
    'upper_grade': 'Upper Primary (Primary 4 - Primary 6)', 
    'jhs': 'Junior High School Specialism'
  },
  
  years: ['Year 1', 'Year 2', 'Year 3', 'Year 4'],
  
  semesters: ['Semester 1', 'Semester 2'],
  
  courses: {
    'Year 1': {
      'Semester 1': {
        'early_grade': [
          'Introduction to Teaching',
          'Child Development and Learning',
          'Basic Mathematics for Teachers',
          'English Language and Literacy',
          'Science for Early Grade Teachers',
          'Ghanaian Languages and Culture',
          'ICT in Education'
        ],
        'upper_grade': [
          'Introduction to Teaching',
          'Child Development and Learning', 
          'Mathematics Methods for Upper Primary',
          'English Language Teaching',
          'Science Education Methods',
          'Social Studies Education',
          'ICT in Education'
        ],
        'jhs': [
          'Introduction to Teaching',
          'Adolescent Psychology',
          'Subject Specialization Methods',
          'Curriculum Studies',
          'Educational Psychology',
          'ICT in Education',
          'Research Methods'
        ]
      },
      'Semester 2': {
        'early_grade': [
          'Classroom Management',
          'Assessment and Evaluation',
          'Creative Arts Education',
          'Physical Education and Health',
          'Environmental Studies',
          'Inclusive Education',
          'Professional Ethics'
        ],
        'upper_grade': [
          'Classroom Management',
          'Assessment and Evaluation', 
          'Creative Arts in Education',
          'Physical Education Methods',
          'Religious and Moral Education',
          'Inclusive Education',
          'Professional Development'
        ],
        'jhs': [
          'Classroom Management',
          'Assessment and Evaluation',
          'Educational Technology',
          'Guidance and Counseling',
          'Special Educational Needs',
          'School-Based Enquiry',
          'Professional Ethics'
        ]
      }
    }
  }
};

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

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
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

    CREATE TABLE IF NOT EXISTS student_progress (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      chatbot_id INTEGER REFERENCES chatbots(id) ON DELETE CASCADE,
      course_name VARCHAR(255),
      topic VARCHAR(255),
      progress_percentage INTEGER DEFAULT 0,
      last_studied TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_college ON users(college_name);
    CREATE INDEX IF NOT EXISTS idx_users_program ON users(program_type, current_year, current_semester);
    CREATE INDEX IF NOT EXISTS idx_chatbots_teacher ON chatbots(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_chatbot_enrollments_chatbot ON chatbot_enrollments(chatbot_id);
    CREATE INDEX IF NOT EXISTS idx_chatbot_enrollments_student ON chatbot_enrollments(student_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
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

// Create default curriculum-based chatbots
async function createDefaultChatbots() {
  try {
    const existingDefaults = await pool.query('SELECT id FROM chatbots WHERE is_default = true LIMIT 1');
    
    if (existingDefaults.rows.length > 0) {
      return;
    }

    const defaultChatbots = [
      {
        name: 'Twenty-First Century Teacher Education Assistant',
        description: 'Your comprehensive B.Ed program support assistant for all Ghana teacher education students',
        subject: 'General Teacher Education',
        system_prompt: DEFAULT_TEACHER_ASSISTANT_PROMPT,
        is_public: true,
        is_default: true,
        target_program: 'all',
        access_code: 'GHANA2024'
      },
      {
        name: 'Early Grade Teaching Specialist',
        description: 'Specialized assistant for Early Grade (K-P3) teacher education students',
        subject: 'Early Grade Education',
        system_prompt: DEFAULT_TEACHER_ASSISTANT_PROMPT + '\n\nI specialize in Early Grade (Kindergarten to Primary 3) education methods and curriculum.',
        is_public: true,
        is_default: true,
        target_program: 'early_grade',
        access_code: 'EARLY2024'
      }
    ];

    for (const chatbot of defaultChatbots) {
      await pool.query(
        `INSERT INTO chatbots (teacher_id, name, description, subject, system_prompt, is_public, is_default, target_program, access_code)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [chatbot.name, chatbot.description, chatbot.subject, chatbot.system_prompt, chatbot.is_public, chatbot.is_default, chatbot.target_program, chatbot.access_code]
      );
    }

    logger.info('✅ Default curriculum chatbots created');
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

// AI Service Class with robust error handling
class GhanaEducationAI {
  constructor() {
    this.providers = [
      { name: 'cohere', client: cohere, available: !!cohere },
      { name: 'together', client: together, available: !!together },
      { name: 'huggingface', client: hf, available: !!hf }
    ];
    
    this.activeProviders = this.providers.filter(p => p.available);
    logger.info(`🤖 AI Providers initialized: ${this.activeProviders.map(p => p.name).join(', ') || 'None - using fallback'}`);
  }

  async generateResponse(message, context = {}, knowledgeBase = []) {
    if (this.activeProviders.length === 0) {
      return {
        response: this.getFallbackResponse(message, context),
        provider: 'fallback',
        success: false
      };
    }

    const prompt = this.buildGhanaEducationPrompt(message, context, knowledgeBase);
    
    // Try each provider in order
    for (const provider of this.activeProviders) {
      try {
        logger.info(`🔄 Trying ${provider.name} for AI response`);
        const response = await this.callProvider(provider, prompt, message);
        
        if (response) {
          logger.info(`✅ Successfully got response from ${provider.name}`);
          return {
            response,
            provider: provider.name,
            success: true
          };
        }
      } catch (error) {
        logger.warn(`⚠️ ${provider.name} failed:`, error.message);
        continue;
      }
    }

    // Fallback response if all AI providers fail
    return {
      response: this.getFallbackResponse(message, context),
      provider: 'fallback',
      success: false
    };
  }

  async callProvider(provider, prompt, originalMessage) {
    switch (provider.name) {
      case 'cohere':
        return await this.callCohere(prompt, originalMessage);
      case 'together':
        return await this.callTogether(prompt, originalMessage);
      case 'huggingface':
        return await this.callHuggingFace(prompt);
      default:
        throw new Error('Unknown provider');
    }
  }

  async callCohere(prompt, originalMessage) {
    if (!cohere) throw new Error('Cohere not initialized');
    
    const response = await cohere.chat({
      model: 'command-r-plus',
      message: originalMessage,
      preamble: prompt,
      max_tokens: 1000,
      temperature: 0.7
    });

    return response.text;
  }

  async callTogether(prompt, originalMessage) {
    if (!together) throw new Error('Together AI not initialized');
    
    const response = await together.chat.completions.create({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: originalMessage }
      ],
      model: 'meta-llama/Llama-3-8b-chat-hf',
      max_tokens: 1000,
      temperature: 0.7
    });

    return response.choices[0]?.message?.content;
  }

  async callHuggingFace(prompt) {
    if (!hf) throw new Error('Hugging Face not initialized');
    
    const response = await hf.textGeneration({
      model: 'microsoft/DialoGPT-large',
      inputs: prompt.substring(0, 500), // Limit input length
      parameters: {
        max_length: 1000,
        temperature: 0.7,
        do_sample: true
      }
    });

    return response.generated_text;
  }

  buildGhanaEducationPrompt(message, context, knowledgeBase) {
    const { user, chatbot, conversationContext } = context;
    
    let prompt = `You are a specialized AI assistant for Ghana's Teacher Education system. You are helping B.Ed students and teachers across Ghana's 47 Colleges of Education.

CONTEXT:
- Student: ${user?.first_name} ${user?.last_name}
- College: ${user?.college_name || 'Ghana College of Education'}
- Program: ${user?.program_type || 'B.Ed Program'}
- Year: ${user?.current_year || 'Current Student'}
- Chatbot: ${chatbot?.name || 'Ghana Education Assistant'}

GHANA EDUCATION SPECIFICS:
- Focus on Ghana's B.Ed curriculum
- Reference Ghana's educational policies and practices
- Use examples relevant to Ghanaian schools
- Include local context and cultural considerations
- Support both English and local language teaching methods

RELEVANT CURRICULUM CONTENT:
${knowledgeBase.length > 0 ? knowledgeBase.map(kb => `- ${kb.course_name}: ${kb.content.substring(0, 200)}...`).join('\n') : 'No specific curriculum materials available'}

GUIDELINES:
1. Be helpful, encouraging, and educational
2. Provide practical advice for Ghanaian classrooms
3. Reference specific B.Ed courses when relevant
4. Include examples from Ghana's educational context
5. Be culturally sensitive and appropriate
6. Use clear, simple English accessible to all students

USER MESSAGE: ${message}

Provide a helpful, contextual response:`;

    return prompt;
  }

  getFallbackResponse(message, context) {
    const responses = [
      `Hello! I'm here to help with your B.Ed studies in Ghana. 🇬🇭 While my AI systems are temporarily unavailable, I can provide basic guidance based on Ghana's teacher education curriculum.

Based on your question about "${message}", here are some key points:

📚 **For Course Materials**: Check your uploaded curriculum documents in this chatbot
🎓 **For Study Support**: Connect with classmates in your ${context.user?.program_type || 'B.Ed'} program
📝 **For Practice**: Review past examination papers from your college
🏫 **For STS**: Consult your mentor teacher for practical guidance

What specific area of your studies would you like more guidance on?`,
      
      `Thank you for your question about "${message}". I'm designed to help B.Ed students across Ghana's 47 Colleges of Education.

🇬🇭 **Ghana-Specific Guidance:**

For **${context.user?.current_year || 'your current year'}** students in **${context.user?.program_type || 'B.Ed programs'}**:

1. **Curriculum Focus**: Refer to your semester course materials
2. **Teaching Practice**: Apply Ghana's educational policies in your STS
3. **Local Context**: Consider Ghanaian classroom environments
4. **Assessment**: Use continuous assessment methods approved by GES

Would you like specific guidance on any of these areas?`,

      `I understand you're asking about your teacher education studies. Even though my advanced AI features are temporarily unavailable, I can help you with:

🎯 **Study Areas for Ghana B.Ed Students:**
- Course content for your current semester
- Teaching methodologies for Ghanaian classrooms  
- Assessment and evaluation techniques
- STS (Supported Teaching in Schools) preparation
- Action research project guidance

Please be more specific about which area you need help with, and I'll provide detailed guidance based on Ghana's teacher education curriculum.`
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }

  // RAG (Retrieval Augmented Generation) function
  async getRelevantKnowledge(chatbotId, userMessage, limit = 3) {
    try {
      // Simple keyword-based retrieval
      const keywords = userMessage.toLowerCase().split(' ').filter(word => word.length > 3);
      if (keywords.length === 0) return [];

      const keywordQuery = keywords.map(word => `content ILIKE '%${word}%'`).join(' OR ');
      
      const result = await pool.query(
        `SELECT * FROM knowledge_base 
         WHERE chatbot_id = $1 AND (${keywordQuery})
         ORDER BY id DESC LIMIT $2`,
        [chatbotId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Knowledge retrieval error:', error);
      return [];
    }
  }
}

// Initialize AI service
const ghanaAI = new GhanaEducationAI();

// Get courses based on curriculum
function getCourses(year, semester, program) {
  try {
    const yearCourses = CURRICULUM_STRUCTURE.courses[year];
    if (!yearCourses) return ['General Education Courses'];
    
    const semesterCourses = yearCourses[semester];
    if (!semesterCourses) return ['General Education Courses'];
    
    if (typeof semesterCourses === 'object' && !Array.isArray(semesterCourses)) {
      return semesterCourses[program] || semesterCourses['common'] || ['General Education Courses'];
    }
    
    return semesterCourses;
  } catch (error) {
    return ['General Education Courses'];
  }
}

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
    status: '🇬🇭 Ghana Education Platform with AI Integration is healthy!',
    timestamp: new Date().toISOString(),
    colleges: GHANA_COLLEGES.length,
    features: ['Multi-AI support', 'Student tracking', 'Curriculum-based chatbots', 'RAG support', 'Teacher analytics'],
    ai_providers: aiStatus
  });
});

// Get Ghana colleges
app.get('/api/colleges', (req, res) => {
  res.json({ success: true, colleges: GHANA_COLLEGES });
});

// Get curriculum structure
app.get('/api/curriculum', (req, res) => {
  res.json({ success: true, curriculum: CURRICULUM_STRUCTURE });
});

// Enhanced user registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { 
      email, password, firstName, lastName, role, collegeName, 
      phoneNumber, region, programType, currentYear, currentSemester, studentId 
    } = req.body;

    if (!email || !password || !firstName || !lastName || !role) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (!['teacher', 'student'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
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
      `INSERT INTO users (email, password_hash, first_name, last_name, role, college_name, phone_number, region, program_type, current_year, current_semester, student_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
       RETURNING id, email, first_name, last_name, role, college_name, program_type, current_year, current_semester, student_id`,
      [email, passwordHash, firstName, lastName, role, collegeName, phoneNumber, region, programType, currentYear, currentSemester, studentId]
    );

    const user = result.rows[0];

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'ghana-education-secret-key',
      { expiresIn: '7d' }
    );

    // Auto-enroll students in default chatbots
    if (role === 'student') {
      const defaultChatbots = await pool.query('SELECT id FROM chatbots WHERE is_default = true');
      for (const chatbot of defaultChatbots.rows) {
        await pool.query(
          'INSERT INTO chatbot_enrollments (chatbot_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [chatbot.id, user.id]
        );
      }
    }

    res.status(201).json({
      success: true,
      message: '🇬🇭 Welcome to Ghana Education Platform with AI!',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        collegeName: user.college_name,
        programType: user.program_type,
        currentYear: user.current_year,
        currentSemester: user.current_semester,
        studentId: user.student_id
      },
      token
    });

  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// Enhanced login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

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
      message: '🇬🇭 Welcome back to your AI-powered learning journey!',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        collegeName: user.college_name,
        programType: user.program_type,
        currentYear: user.current_year,
        currentSemester: user.current_semester,
        studentId: user.student_id
      },
      token
    });

  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// Get available chatbots with enrollment info
app.get('/
