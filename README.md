# Legal Counsel Analysis - ContractAI

An AI-powered legal contract analysis platform with role-based insights for Investors, Legal Counsel, Project Managers, and HR professionals.

## Features

- **Multi-Role Contract Analysis**: Upload contracts and analyze them from different professional perspectives
- **Role-Based Insights**: Get tailored analysis for:
  - **Investor**: Financial exposure, ROI impact, and risk assessment
  - **Legal**: Compliance, liability, governing law, and clause nuance
  - **PM**: Deliverables, timelines, IP rights, and operational requirements
  - **HR**: Employment terms, confidentiality, and data privacy
- **AI-Powered Chat**: Interactive chat assistant that provides role-specific contract insights
- **Document Management**: Track and manage multiple contracts
- **Secure File Upload**: Support for PDF and DOCX files with encryption

## Tech Stack

- **Backend**: Node.js with Express
- **Frontend**: Vanilla JavaScript with Tailwind CSS
- **File Upload**: Multer for handling file uploads
- **Real-time Analysis**: Polling mechanism for AI analysis updates

## Installation

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Start the backend server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

The server will start on `http://localhost:3000`

## Project Structure

```
stitch_legal_counsel_analysis_view/
├── backend/
│   ├── package.json
│   ├── server.js          # Express server with API endpoints
│   └── uploads/           # Temporary file storage (auto-created)
├── frontend/
│   ├── index.html         # Main HTML template
│   └── js/
│       └── app.js         # Frontend application logic
├── contract_upload_&_role_selection_1/
├── contract_upload_&_role_selection_2/
├── investor_risk_analysis_view_1/
├── investor_risk_analysis_view_2/
├── legal_counsel_analysis_view_1/
├── legal_counsel_analysis_view_2/
├── pm_operational_analysis_view_1/
├── pm_operational_analysis_view_2/
├── role-aware_ai_chatbot_assistant_1/
└── role-aware_ai_chatbot_assistant_2/
```

## API Endpoints

### Contracts
- `GET /api/contracts` - Get all contracts
- `GET /api/contracts/:id` - Get a specific contract
- `POST /api/contracts/upload` - Upload a new contract
- `DELETE /api/contracts/:id` - Delete a contract
- `PATCH /api/contracts/:id/role` - Update contract role

### Analysis
- `GET /api/contracts/:id/analysis` - Get analysis for a contract

### Chat
- `POST /api/chat` - Send a message to the AI assistant

### Health
- `GET /api/health` - Health check endpoint

## Usage

1. Open your browser and navigate to `http://localhost:3000`

2. **Upload a Contract**:
   - Select your role (Investor, Legal, PM, or HR)
   - Drag and drop a PDF or DOCX file, or click to browse
   - Wait for the AI analysis to complete

3. **View Analysis**:
   - Navigate between different views using the top navigation
   - Each view provides role-specific insights and recommendations

4. **Chat with AI**:
   - Use the AI Chat view to ask questions about the contract
   - Get responses tailored to your selected role
   - Use quick question buttons for common queries

## Role-Specific Views

### Investor View
- Total financial exposure
- Risk profile assessment
- LTV impact analysis
- Investor compliance score
- Market benchmarking

### Legal View
- Compliance checks (GDPR, CCPA)
- Enforceability risks
- Jurisdiction context
- Clause-by-clause analysis
- Suggested edits and mitigations

### PM View
- Key deliverables tracking
- IP usage rights
- Project timelines
- Action items management
- Operational insights

### AI Chat View
- Role-aware contract Q&A
- Citation-backed responses
- Role-specific implications
- Quick question shortcuts
- Context file support

## File Upload Limits

- Supported formats: PDF, DOCX, DOC
- Maximum file size: 50MB
- Automatic encryption and SOC2 compliance

## Development Notes

- The backend uses in-memory storage for contracts and analyses
- In production, replace with a proper database (PostgreSQL, MongoDB, etc.)
- AI analysis is currently mocked - integrate with your preferred AI service
- File uploads are stored in the `backend/uploads` directory

## Customization

### Adding New Roles

1. Add the role to the role selector in `frontend/js/app.js`
2. Update the `generateMockAnalysis` function in `backend/server.js`
3. Add corresponding view renderer in `frontend/js/app.js`

### Integrating Real AI

Replace the mock analysis in `backend/server.js` with calls to your AI service:
```javascript
async function generateRealAnalysis(contract) {
    // Call your AI service here
    const analysis = await aiService.analyze(contract);
    return analysis;
}
```

## License

MIT

## Support

For issues or questions, please contact the development team.
