# ContractAI - Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Browser)                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Single Page Application (Vanilla JS + Tailwind)      │  │
│  │  - Upload View                                         │  │
│  │  - Investor View                                       │  │
│  │  - Legal View                                          │  │
│  │  - PM View                                             │  │
│  │  - AI Chat View                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP/REST API
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                    Backend (Node.js + Express)                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  API Routes                                           │  │
│  │  - GET  /api/contracts                                │  │
│  │  - POST /api/contracts/upload                          │  │
│  │  - GET  /api/contracts/:id                            │  │
│  │  - GET  /api/contracts/:id/analysis                   │  │
│  │  - PATCH /api/contracts/:id/role                       │  │
│  │  - DELETE /api/contracts/:id                           │  │
│  │  - POST /api/chat                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Business Logic                                       │  │
│  │  - File Upload (Multer)                               │  │
│  │  - Contract Management (In-Memory)                     │  │
│  │  - AI Analysis Generation (Mock)                        │  │
│  │  - Role-Based Response Routing                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Data Store                                           │  │
│  │  - contracts: Map<id, Contract>                       │  │
│  │  - analyses: Map<id, Analysis>                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  File System │
                        │  /uploads/   │
                        └──────────────┘
```

## Component Details

### Frontend Components

#### 1. State Management
- **Location**: `frontend/js/app.js`
- **Purpose**: Centralized application state
- **State Object**:
  ```javascript
  {
    currentView: 'upload' | 'investor' | 'legal' | 'pm' | 'chat',
    selectedRole: 'Investor' | 'Legal' | 'PM' | 'HR',
    contracts: Array<Contract>,
    currentContract: Contract | null,
    currentAnalysis: Analysis | null,
    chatMessages: Array<Message>,
    isLoading: boolean
  }
  ```

#### 2. View Renderers
Each view has a dedicated renderer function:
- `renderUploadView()` - File upload and role selection
- `renderInvestorView()` - Financial risk analysis
- `renderLegalView()` - Compliance and legal insights
- `renderPMView()` - Operational analysis
- `renderChatView()` - AI-powered Q&A

#### 3. API Client
Functions for backend communication:
- `fetchContracts()` - Get all contracts
- `uploadContract(file, role)` - Upload new contract
- `getAnalysis(contractId)` - Get analysis results
- `updateContractRole(contractId, role)` - Change analysis perspective
- `sendChatMessage(contractId, message, role)` - Chat with AI

### Backend Components

#### 1. Express Server
- **Location**: `backend/server.js`
- **Port**: 3000 (configurable via PORT env var)
- **Middleware**:
  - `cors()` - Enable CORS
  - `express.json()` - Parse JSON bodies
  - `express.urlencoded()` - Parse URL-encoded bodies
  - `multer` - Handle multipart/form-data (file uploads)

#### 2. API Endpoints

| Method | Endpoint | Description | Request | Response |
|---------|-----------|-------------|----------|----------|
| GET | `/api/health` | Health check | - | `{ status, timestamp }` |
| GET | `/api/contracts` | List all contracts | - | `Array<Contract>` |
| POST | `/api/contracts/upload` | Upload contract | `FormData` | `Contract` |
| GET | `/api/contracts/:id` | Get contract | - | `Contract` |
| GET | `/api/contracts/:id/analysis` | Get analysis | - | `Analysis` |
| PATCH | `/api/contracts/:id/role` | Update role | `{ role }` | `{ id, role, status }` |
| DELETE | `/api/contracts/:id` | Delete contract | - | `{ message }` |
| POST | `/api/chat` | Chat with AI | `{ contractId, message, role }` | `ChatResponse` |

#### 3. Data Models

**Contract**
```javascript
{
  id: string,
  name: string,
  fileName: string,
  originalName: string,
  filePath: string,
  fileSize: number,
  uploadDate: string (ISO),
  status: 'analyzing' | 'completed',
  role: 'Investor' | 'Legal' | 'PM' | 'HR'
}
```

**Analysis** (Role-specific)
```javascript
// Common fields
{
  contractId: string,
  contractName: string,
  generatedAt: string,
  overallRisk: string,
  riskScore: number,
  complianceScore: number
}

// Investor-specific
{
  financialExposure: string,
  ltvImpact: string,
  investorCompliance: string,
  riskFactors: Array<RiskFactor>,
  marketBenchmark: { matchPercentage, note }
}

// Legal-specific
{
  clauses: number,
  totalClauses: number,
  enforceabilityRisks: Array<Risk>,
  complianceChecks: Array<ComplianceCheck>,
  jurisdiction: { location, governingLaw, notes }
}

// PM-specific
{
  deliverables: Array<Deliverable>,
  ipRights: { customerData, saasSoftware, usageRestrictions },
  timelines: Array<Timeline>,
  actionItems: Array<ActionItem>
}
```

## Data Flow

### Contract Upload Flow

```
User selects file & role
    ↓
Frontend: handleFileSelect()
    ↓
Frontend: uploadContract(file, role)
    ↓
POST /api/contracts/upload
    ↓
Backend: multer saves file to /uploads/
    ↓
Backend: Create Contract record
    ↓
Backend: Return Contract with ID
    ↓
Frontend: Start polling for analysis
    ↓
Backend: Simulate AI analysis (2s delay)
    ↓
Backend: Generate role-specific analysis
    ↓
Frontend: Receive analysis via polling
    ↓
Frontend: Navigate to role-specific view
```

### Role Switching Flow

```
User clicks "Switch Role"
    ↓
Frontend: selectRole(newRole)
    ↓
Frontend: updateContractRole(contractId, newRole)
    ↓
PATCH /api/contracts/:id/role
    ↓
Backend: Update contract role
    ↓
Backend: Regenerate analysis for new role
    ↓
Frontend: Poll for new analysis
    ↓
Frontend: Update view with new perspective
```

### Chat Flow

```
User types question
    ↓
Frontend: sendChatMessage()
    ↓
POST /api/chat
    ↓
Backend: generateChatResponse(message, role, contract)
    ↓
Backend: Return role-specific response
    ↓
Frontend: Display response with citations
```

## Integration Points

### Stitch Views Integration

The original stitch views have been integrated as follows:

| Stitch View | Integrated As | Location |
|-------------|---------------|----------|
| `contract_upload_&_role_selection_1/code.html` | Upload View | `renderUploadView()` |
| `investor_risk_analysis_view_1/code.html` | Investor View | `renderInvestorView()` |
| `legal_counsel_analysis_view_1/code.html` | Legal View | `renderLegalView()` |
| `pm_operational_analysis_view_1/code.html` | PM View | `renderPMView()` |
| `role-aware_ai_chatbot_assistant_1/code.html` | AI Chat View | `renderChatView()` |

All views share:
- Common header with navigation
- Consistent styling (Tailwind CSS)
- Role-based analysis data
- Contract context

### Future Integration Points

1. **AI Service Integration**
   - Replace `generateMockAnalysis()` with real AI API calls
   - Support OpenAI, Claude, or custom AI models
   - Add streaming responses for real-time analysis

2. **Database Integration**
   - Replace in-memory Maps with PostgreSQL/MongoDB
   - Add user authentication and authorization
   - Implement contract versioning

3. **File Storage Integration**
   - Replace local filesystem with S3/Cloud Storage
   - Add document processing pipeline
   - Implement OCR for scanned documents

4. **Notification Integration**
   - Add email notifications for analysis completion
   - Implement WebSocket for real-time updates
   - Add Slack/Teams integration

## Security Considerations

1. **File Upload Validation**
   - File type validation (PDF, DOCX only)
   - File size limits (50MB max)
   - Sanitized filenames to prevent path traversal

2. **Data Protection**
   - Files stored in secure directory
   - End-to-end encryption (mocked)
   - SOC2 Type II compliance (mocked)

3. **API Security**
   - CORS enabled for development
   - Rate limiting (to be added)
   - Authentication/authorization (to be added)

## Performance Optimization

1. **Frontend**
   - Single-page application (no page reloads)
   - Lazy loading of views
   - Debounced search and chat input

2. **Backend**
   - In-memory storage for fast access
   - Polling with exponential backoff
   - Async file operations

3. **Future Optimizations**
   - Implement caching for repeated analyses
   - Add CDN for static assets
   - Use WebSocket instead of polling

## Deployment Architecture

```
┌─────────────────────────────────────────────────┐
│              Load Balancer (Nginx)           │
└──────────────┬───────────────────────────────┘
               │
    ┌──────────┴──────────┐
    │                     │
┌───▼────┐         ┌─────▼────┐
│ Node 1 │         │  Node 2  │
│ :3000  │         │  :3000   │
└───┬────┘         └─────┬────┘
    │                     │
    └──────────┬──────────┘
               │
    ┌──────────┴──────────┐
    │                     │
┌───▼────┐         ┌─────▼────┐
│  Redis  │         │PostgreSQL │
│ (Cache) │         │ (DB)     │
└─────────┘         └──────────┘
```

## Monitoring & Logging

### Current Implementation
- Console logging for development
- Error handling with try-catch blocks
- Health check endpoint

### Recommended Additions
- Structured logging (Winston/Pino)
- Metrics collection (Prometheus)
- Error tracking (Sentry)
- APM integration (New Relic/DataDog)

## Testing Strategy

### Unit Tests (To Be Added)
- API endpoint tests
- Business logic tests
- State management tests

### Integration Tests (To Be Added)
- End-to-end user flows
- File upload tests
- Chat interaction tests

### Manual Testing Checklist
- [ ] Upload contract for each role
- [ ] Navigate between views
- [ ] Switch contract role
- [ ] Chat with AI assistant
- [ ] Delete contract
- [ ] View recent documents

## License

MIT License - See LICENSE file for details
